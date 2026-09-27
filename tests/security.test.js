const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const originalDownloadDir = process.env.DOWNLOAD_DIR;
process.env.DOWNLOAD_DIR = path.join(os.tmpdir(), 'video-downloader-test-root');

const fileHelper = require('../lib/file-helper');
const douyin = require('../lib/douyin');
const schedulerService = require('../lib/scheduler-service');
const taskManager = require('../lib/task-manager');
const historyRouter = require('../routes/history');

test('isPathSafe rejects download root itself', () => {
  const root = process.env.DOWNLOAD_DIR;
  assert.equal(fileHelper.isPathSafe(root), false);
});

test('isPathSafe accepts file within download root', () => {
  const target = path.join(process.env.DOWNLOAD_DIR, 'sub', 'video.mp4');
  assert.equal(fileHelper.isPathSafe(target), true);
});

test('getSafeDownloadUrl accepts allowed https douyin url', () => {
  const result = douyin.getSafeDownloadUrl('https://www.douyin.com/aweme/v1/play/?video_id=1');
  assert.equal(result.hostname, 'www.douyin.com');
});

test('getSafeDownloadUrl rejects non-http protocol', () => {
  assert.throws(() => douyin.getSafeDownloadUrl('file:///tmp/a.mp4'), /仅支持/);
});

test('getSafeDownloadUrl rejects untrusted host', () => {
  assert.throws(() => douyin.getSafeDownloadUrl('https://evil.example.com/video.mp4'), /不受信任/);
});

test('scheduler guard rejects concurrent runs', async () => {
  schedulerService.__setScheduledSyncRunnerForTest(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { ok: true };
  });

  const first = schedulerService.runScheduledSync();
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(() => schedulerService.runScheduledSync(), /正在执行/);
  await first;
  schedulerService.__setScheduledSyncRunnerForTest(null);
});

test('task manager coalesces concurrent saves into one flush promise', async () => {
  const first = taskManager.__queueSaveForTest();
  const second = taskManager.__queueSaveForTest();
  assert.equal(first, second);
  await first;
});

test('task manager flushes again when updates arrive during save', async () => {
  let callCount = 0;
  let releaseFirstSave;
  const firstSaveReleased = new Promise(resolve => {
    releaseFirstSave = resolve;
  });

  taskManager.__setSaveTasksImplForTest(async () => {
    callCount += 1;
    if (callCount === 1) {
      await firstSaveReleased;
    }
  });

  const first = taskManager.__queueSaveForTest();
  const second = taskManager.__queueSaveForTest();
  assert.equal(first, second);

  const pending = taskManager.__queueSaveForTest();
  releaseFirstSave();
  await pending;

  assert.equal(callCount, 2);
  taskManager.__setSaveTasksImplForTest(null);
});

test('history route returns completed download tasks sorted by startTime desc', async () => {
  const originalGetAllTasks = taskManager.getAllTasks;
  taskManager.getAllTasks = () => ([
    { id: '1', status: 'done', startTime: 100, fileName: 'a.mp4' },
    { id: '2', status: 'error', startTime: 200, fileName: 'b.mp4' },
    { id: '3', status: 'done', startTime: 300, fileName: 'c.mp4' }
  ]);

  try {
    const layer = historyRouter.stack.find(item => item.route && item.route.path === '/history' && item.route.methods.get);
    const handler = layer.route.stack[0].handle;

    let jsonPayload = null;
    handler({}, {
      json(payload) {
        jsonPayload = payload;
      }
    });

    assert.deepEqual(jsonPayload.map(item => item.id), ['3', '1']);
  } finally {
    taskManager.getAllTasks = originalGetAllTasks;
  }
});

test('history delete route rejects when remote management disabled', async () => {
  const layer = historyRouter.stack.find(item => item.route && item.route.path === '/history/delete' && item.route.methods.post);
  const handler = layer.route.stack[0].handle;

  let statusCode = 200;
  let jsonPayload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonPayload = payload;
      return this;
    }
  };

  await handler({ app: { locals: { remoteManagementDisabled: true } }, body: { filePath: '/tmp/a.mp4' } }, res);

  assert.equal(statusCode, 403);
  assert.match(jsonPayload.error, /禁用远程删除/);
});

test('history delete route rejects missing file path', async () => {
  const layer = historyRouter.stack.find(item => item.route && item.route.path === '/history/delete' && item.route.methods.post);
  const handler = layer.route.stack[0].handle;

  let statusCode = 200;
  let jsonPayload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonPayload = payload;
      return this;
    }
  };

  await handler({ app: { locals: { remoteManagementDisabled: false } }, body: {} }, res);

  assert.equal(statusCode, 400);
  assert.match(jsonPayload.error, /未提供文件路径/);
});

test('sanitizeFilename limits output to safe UTF-8 byte length', () => {
  const superLongTitle = '这是一个非常非常长的绘本标题，后面跟着一大堆介绍和标签'.repeat(10);
  const sanitized = douyin.sanitizeFilename(superLongTitle);
  assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 150);
  assert.ok(Buffer.byteLength(sanitized + '_7629214414708788532.mp4', 'utf8') <= 255);
});

test.after(() => {
  if (originalDownloadDir === undefined) {
    delete process.env.DOWNLOAD_DIR;
  } else {
    process.env.DOWNLOAD_DIR = originalDownloadDir;
  }
});
