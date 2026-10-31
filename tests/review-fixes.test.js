const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Readable } = require('stream');

// 被测模块会打印大量中文日志；Node 24 的 --test 子进程模式下个别中文字节会被误判为 IPC 消息头，
// 偶发 "Unable to deserialize cloned data"。本文件只关心断言，静音 stdout 日志
console.log = () => {};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-review-'));
const downloadRoot = path.join(tmpRoot, 'downloads');
fs.mkdirSync(downloadRoot, { recursive: true });
process.env.DOWNLOAD_DIR = downloadRoot;

const axios = require('axios');
const douyin = require('../lib/douyin');
const fileHelper = require('../lib/file-helper');
const profileLock = require('../lib/profile-lock');
const favorites = require('../lib/douyin-favorites');
const configHelper = require('../lib/config');
const scheduler = require('../lib/scheduler-service');

const CDN = 'https://v26-cold.douyinvod.com/video/x';

// 模拟 axios 流式响应：声明 contentLength 字节，实际发送 body
function stubAxiosStream(t, body, contentLength = body.length) {
  t.mock.method(axios, 'get', async () => ({
    headers: { 'content-length': String(contentLength) },
    data: Readable.from([Buffer.from(body)]),
  }));
}

test('resolveWithinRoot rejects traversal via subDir and awemeId', () => {
  assert.throws(() => fileHelper.resolveWithinRoot(downloadRoot, '..'), /非法下载路径/);
  assert.throws(() => fileHelper.resolveWithinRoot(downloadRoot, '[图集]_demo_/../../outside'), /非法下载路径/);
  assert.equal(fileHelper.resolveWithinRoot(downloadRoot, 'a.mp4'), path.join(downloadRoot, 'a.mp4'));
});

test('buildDownloadName strips path syntax from awemeId', () => {
  const name = douyin.buildDownloadName({ type: 'image', title: 'demo', awemeId: '/../../outside' });
  assert.equal(name, '[图集]_demo_outside');
  assert.ok(!name.includes('/'));
});

test('resolveExistingWithinRoot rejects symlink escaping the download root', () => {
  const outside = path.join(tmpRoot, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
  fs.symlinkSync(outside, path.join(downloadRoot, 'linked'));
  const viaLink = path.join(downloadRoot, 'linked', 'secret.txt');
  assert.equal(fileHelper.isPathSafe(viaLink), true); // 纯字符串判断会放行
  assert.throws(() => fileHelper.resolveExistingWithinRoot(viaLink), /越界/);
  assert.throws(() => fileHelper.resolveExistingWithinRoot(path.join(downloadRoot, 'linked')), /符号链接/);
  return assert.rejects(fileHelper.safeDeleteFile(viaLink)).then(() => {
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
  });
});

test('downloadVideo keeps the existing file when the transfer is truncated', async (t) => {
  const target = path.join(downloadRoot, 'existing.mp4');
  fs.writeFileSync(target, 'GOOD-OLD-CONTENT');
  stubAxiosStream(t, 'short', 100);
  await assert.rejects(douyin.downloadVideo(CDN, target), /下载不完整/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'GOOD-OLD-CONTENT');
  assert.deepEqual(fs.readdirSync(downloadRoot).filter(f => f.endsWith('.part')), []);
});

test('downloadVideo writes atomically on success', async (t) => {
  const target = path.join(downloadRoot, 'ok.mp4');
  stubAxiosStream(t, 'complete-body');
  const r = await douyin.downloadVideo(CDN, target);
  assert.equal(r.fileSize, 'complete-body'.length);
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete-body');
});

test('downloadImages fails when an image response is shorter than Content-Length', async (t) => {
  stubAxiosStream(t, '12345', 100);
  await assert.rejects(
    douyin.downloadImages(['https://p3-sign.douyinpic.com/a.jpeg'], path.join(downloadRoot, '[图集]_t_1')),
    /图集下载不完整/
  );
});

test('profileLock.run serializes and tryAcquire refuses while busy', async () => {
  const order = [];
  let releaseFirst;
  const first = profileLock.run('A', () => new Promise(r => { releaseFirst = r; order.push('A start'); }));
  const second = profileLock.run('B', async () => { order.push('B start'); });
  await new Promise(r => setImmediate(r));
  assert.equal(profileLock.tryAcquire(), null);
  assert.deepEqual(order, ['A start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['A start', 'B start']);
  const release = profileLock.tryAcquire();
  assert.equal(typeof release, 'function');
  release();
});

test('queued sync stopped while waiting does not start a browser', async () => {
  let releaseBlocker;
  const blocker = profileLock.run('blocker', () => new Promise(r => { releaseBlocker = r; }));
  let stopped = false;
  const pending = favorites.fetchFavorites(5, null, () => stopped, 'favorite');
  stopped = true; // 用户在排队期间点了停止
  await new Promise(r => setImmediate(r)); // 等 blocker 出队开始运行
  releaseBlocker();
  await blocker;
  assert.deepEqual(await pending, []);
});

test('scheduler keeps successful sources when another source fails', async (t) => {
  scheduler.__setRetryDelayForTest(0);
  const logs = [];
  t.mock.method(configHelper, 'readScheduleConfig', async () => ({ syncMode: 'both', maxCount: 5 }));
  t.mock.method(configHelper, 'getEffectiveDownloadDir', async () => downloadRoot);
  t.mock.method(configHelper, 'appendScheduleLog', async (e) => { logs.push(e); });
  t.mock.method(favorites, 'checkLoginStatus', async () => ({ loggedIn: true }));
  t.mock.method(favorites, 'getSyncedData', async () => ({ ids: [] }));
  t.mock.method(favorites, 'getLikedData', async () => ({ ids: [] }));
  t.mock.method(favorites, 'saveSyncedIds', async () => {});
  t.mock.method(favorites, 'saveLikedIds', async () => {});
  let favCalls = 0;
  t.mock.method(favorites, 'fetchFavorites', async () => { favCalls++; throw new Error('goto timeout'); });
  t.mock.method(favorites, 'fetchLikedVideos', async () => ([{
    aweme_id: '7000000000000000001', desc: 'liked one',
    video: { play_addr: { uri: 'v0', url_list: ['https://aweme.snssdk.com/aweme/v1/play/?video_id=v0'] } },
  }]));
  const downloaded = [];
  t.mock.method(douyin, 'downloadVideo', async (url, savePath) => { downloaded.push(savePath); return { fileSize: 1 }; });

  const entry = await scheduler.executeScheduledSync();
  assert.equal(favCalls, 3);
  assert.equal(entry.error, null);
  assert.match(entry.partialError, /收藏: goto timeout/);
  assert.equal(entry.totalFound, 1);
  assert.equal(downloaded.length, 1);
  assert.deepEqual(entry.results, { success: 1, fail: 0 });
  scheduler.__setRetryDelayForTest(3 * 60 * 1000);
});

test('scheduler retries failed downloads and does not skip a partial image folder', async (t) => {
  scheduler.__setRetryDelayForTest(0);
  t.mock.method(configHelper, 'readScheduleConfig', async () => ({ syncMode: 'liked', maxCount: 5 }));
  t.mock.method(configHelper, 'getEffectiveDownloadDir', async () => downloadRoot);
  t.mock.method(configHelper, 'appendScheduleLog', async () => {});
  t.mock.method(favorites, 'checkLoginStatus', async () => ({ loggedIn: true }));
  t.mock.method(favorites, 'getSyncedData', async () => ({ ids: [] }));
  t.mock.method(favorites, 'getLikedData', async () => ({ ids: [] }));
  const saved = [];
  t.mock.method(favorites, 'saveSyncedIds', async (ids) => { saved.push(...ids); });
  t.mock.method(favorites, 'saveLikedIds', async () => {});
  t.mock.method(favorites, 'fetchLikedVideos', async () => ([{
    aweme_id: '7000000000000000002', desc: 'album',
    images: [{ url_list: ['https://p3-sign.douyinpic.com/a.jpeg'] }],
  }]));
  // 上次失败留下的残缺目录
  fs.mkdirSync(path.join(downloadRoot, '[图集]_album_7000000000000000002'), { recursive: true });
  let calls = 0;
  t.mock.method(douyin, 'downloadImages', async () => {
    calls++;
    if (calls < 3) throw new Error('connect ECONNREFUSED');
    return { fileSize: 1 };
  });

  const entry = await scheduler.executeScheduledSync();
  assert.equal(calls, 3);
  assert.deepEqual(entry.results, { success: 1, fail: 0 });
  assert.deepEqual(saved, ['7000000000000000002']);
  scheduler.__setRetryDelayForTest(3 * 60 * 1000);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
