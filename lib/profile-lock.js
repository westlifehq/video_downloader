/**
 * user_data 浏览器 profile 的占用管理。
 * 登录 / 退出 / 收藏 / 喜欢 / 私信 / 用户主页 / 定时同步 / 解析兜底都启动同一个持久化 profile，
 * Chromium 同时只允许一个进程使用它：
 * - run(): 排队独占，适用于同步、登录等必须用登录态的操作；
 * - tryAcquire(): 空闲才占用、忙则立即返回 null，适用于解析兜底（不该为等同步而卡几分钟，忙时改用临时会话）。
 */
let queue = Promise.resolve();
let busy = 0; // 运行中 + 排队中的数量

function run(name, fn) {
  if (busy > 0) console.log(`[${name}] 浏览器 profile 被占用，排队等待`);
  busy++;
  const result = queue.then(() => fn());
  queue = result.then(() => {}, () => {}).then(() => { busy--; });
  return result;
}

function tryAcquire() {
  if (busy > 0) return null;
  busy++;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  queue = queue.then(() => held).then(() => { busy--; });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function isBusy() {
  return busy > 0;
}

module.exports = { run, tryAcquire, isBusy };
