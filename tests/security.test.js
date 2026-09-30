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

test('fav sync route passthrough keeps livePhotos and uses live-photo folder prefix', async () => {
  const os = require('os');
  const syncRouter = require('../routes/sync');
  const favorites = require('../lib/douyin-favorites');
  const configHelper = require('../lib/config');

  const original = {
    fetchFavorites: favorites.fetchFavorites,
    getSyncedData: favorites.getSyncedData,
    getEffectiveDownloadDir: configHelper.getEffectiveDownloadDir,
    createTask: taskManager.createTask,
    updateTask: taskManager.updateTask,
    getTask: taskManager.getTask,
    getAllTasks: taskManager.getAllTasks
  };

  const store = new Map();
  taskManager.createTask = async (type, id, data) => { store.set(id, { ...data, id }); };
  taskManager.updateTask = async (type, id, patch) => { Object.assign(store.get(id), patch); };
  taskManager.getTask = (type, id) => store.get(id);
  taskManager.getAllTasks = () => [...store.values()];
  favorites.fetchFavorites = async () => ([{
    aweme_id: 'livetest001',
    desc: '实况图回归测试',
    images: [{
      url_list: ['https://p3-sign.douyinpic.com/test.jpeg'],
      video: { playAddr: [{ src: 'https://www.douyin.com/aweme/v1/play/?video_id=livetest' }] }
    }]
  }]);
  favorites.getSyncedData = async () => ({ ids: [] });
  configHelper.getEffectiveDownloadDir = async () => os.tmpdir();

  try {
    const layer = syncRouter.stack.find(item => item.route && item.route.path === '/favorites/sync' && item.route.methods.post);
    const handler = layer.route.stack[0].handle;

    let response = null;
    await handler({ body: { maxCount: 1 } }, { json(payload) { response = payload; }, status() { return this; } });
    assert.ok(response && response.taskId, 'sync route should return taskId');

    for (let i = 0; i < 80; i++) {
      const task = store.get(response.taskId);
      if (task && task.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const task = store.get(response.taskId);
    assert.equal(task.status, 'done');
    assert.equal(task.items.length, 1);
    assert.equal(task.items[0].type, 'image');
    assert.ok(Array.isArray(task.items[0].livePhotos) && task.items[0].livePhotos.length === 1,
      'livePhotos must survive the sync item mapping');
    assert.ok(task.items[0].livePhotos[0].videoUrl.includes('video_id=livetest'));
    assert.ok(task.items[0].fileName.startsWith('[实况图]_'), 'live photo item must use live-photo prefix');
  } finally {
    Object.assign(favorites, { fetchFavorites: original.fetchFavorites, getSyncedData: original.getSyncedData });
    configHelper.getEffectiveDownloadDir = original.getEffectiveDownloadDir;
    Object.assign(taskManager, {
      createTask: original.createTask, updateTask: original.updateTask,
      getTask: original.getTask, getAllTasks: original.getAllTasks
    });
  }
});
