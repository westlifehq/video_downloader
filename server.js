const express = require('express');
const path = require('path');
const schedulerService = require('./lib/scheduler-service');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// 全局异常捕获，防止黑窗口闪退
function pressAnyKeyToExit() {
    console.log('\n================================');
    console.log('程序遇到错误，请截图发给开发者。');
    console.log('按任意键退出...');
    if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', process.exit.bind(process, 1));
    } else {
        process.exit(1);
    }
}

process.on('uncaughtException', (err) => {
    console.error('\n[致命错误]', err.message);
    console.error(err.stack);
    pressAnyKeyToExit();
});

process.on('unhandledRejection', (err) => {
    console.error('\n[未捕获的 Promise 错误]', err);
    pressAnyKeyToExit();
});

// 引入模块化路由
const configRouter = require('./routes/config');
const parseRouter = require('./routes/parse');
const downloadRouter = require('./routes/download');
const historyRouter = require('./routes/history');
const syncRouter = require('./routes/sync');

// 挂载路由
app.use('/api', configRouter);
app.use('/api', parseRouter);
app.use('/api', downloadRouter);
app.use('/api', historyRouter);
app.use('/api', syncRouter);

// 启动服务器 — 本地模式绑定 127.0.0.1，Docker/NAS 模式绑定 0.0.0.0
const isDocker = require('fs').existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
const HOST = process.env.HOST || (isDocker ? '0.0.0.0' : '127.0.0.1');

app.listen(PORT, HOST, () => {
    console.log(`\n🎬 抖音视频下载器已启动`);
    console.log(`📍 http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    schedulerService.startScheduledTask();
});
