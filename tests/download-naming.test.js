const test = require('node:test');
const assert = require('node:assert/strict');

const douyin = require('../lib/douyin');
const { computeRandomDelay } = require('../lib/scheduler-service');

test('buildDownloadName: image folders include awemeId so same titles do not collide', () => {
  const a = douyin.buildDownloadName({ type: 'image', title: '未知标题', awemeId: '111' });
  const b = douyin.buildDownloadName({ type: 'image', title: '未知标题', awemeId: '222' });
  assert.equal(a, '[图集]_未知标题_111');
  assert.notEqual(a, b);
});

test('buildDownloadName: live photo prefix, legacy name and video name', () => {
  const live = { type: 'image', title: 't', awemeId: '9', livePhotos: [{ index: 0, videoUrl: 'x' }] };
  assert.equal(douyin.buildDownloadName(live), '[实况图]_t_9');
  assert.equal(douyin.buildDownloadName(live, { legacy: true }), '[实况图]_t');
  assert.equal(douyin.buildDownloadName({ type: 'video', title: 't', awemeId: '9' }), 't_9.mp4');
});

test('normalizeVideoData: share-page play url is rewritten to ratio=default without watermark', () => {
  const info = douyin.normalizeVideoData({
    aweme_id: '1', desc: 'd',
    video: { play_addr: { uri: 'v0', url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0&ratio=720p&line=0'] } },
  });
  const u = new URL(info.videoUrl);
  assert.equal(u.pathname, '/aweme/v1/play/');
  assert.equal(u.searchParams.get('ratio'), 'default');
});

test('computeRandomDelay: same-day window', () => {
  const cfg = { rangeStart: '00:00', rangeEnd: '06:00' };
  assert.equal(computeRandomDelay(cfg, 7 * 60), null);
  const p = computeRandomDelay(cfg, 60, () => 0);
  assert.deepEqual(p, { delayMinutes: 1, atMinutes: 61 });
});

test('computeRandomDelay: window crossing midnight fires before and after midnight', () => {
  const cfg = { rangeStart: '23:00', rangeEnd: '02:00' };
  assert.equal(computeRandomDelay(cfg, 22 * 60), null);
  const atStart = computeRandomDelay(cfg, 23 * 60, () => 0.999);
  assert.equal(atStart.atMinutes, 1 * 60 + 59);
  const afterMidnight = computeRandomDelay(cfg, 30, () => 0);
  assert.deepEqual(afterMidnight, { delayMinutes: 1, atMinutes: 31 });
  assert.equal(computeRandomDelay(cfg, 2 * 60 + 30), null);
});
