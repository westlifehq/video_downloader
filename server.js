const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const douyin = require('./lib/douyin');
const xhs = require('./lib/xhs');
const favorites = require('./lib/douyin-favorites');


const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 配置文件路径：适配 pkg 打包（process.cwd() 为真实运行目录的路径）
const isPkg = typeof process.pkg !== 'undefined';
const exeDir = isPkg ? path.dirname(process.execPath) : process.cwd();
const CONFIG_PATH = path.join(exeDir, 'config.json');

const readline = require('readline');
function pressAnyKeyToExit() {
    console.log('\n================================');
    console.log('程序遇到错误，请截图发给开发者。');
    console.log('按任意键退出...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 1));
}

// 全局异常捕获，防止黑窗口闪退
process.on('uncaughtException', (err) => {
    console.error('\n[致命错误]', err.message);
    console.error(err.stack);
    pressAnyKeyToExit();
});
process.on('unhandledRejection', (err) => {
    console.error('\n[未捕获的 Promise 错误]', err);
    pressAnyKeyToExit();
});

// 下载任务状态存储
const downloadTasks = new Map();

/**
 * 读取配置
 */
function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
        return { downloadDir: '' };
    }
}

/**
 * 写入配置
 */
function writeConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * GET /api/config — 获取配置
 */
app.get('/api/config', (req, res) => {
    const config = readConfig();
    // 如果没有设置下载目录，用默认值
    if (!config.downloadDir) {
        config.downloadDir = path.join(require('os').homedir(), 'Downloads', 'douyin');
    }
    res.json(config);
});

/**
 * POST /api/config — 保存配置
 */
app.post('/api/config', (req, res) => {
    const { downloadDir } = req.body;
    if (!downloadDir) {
        return res.status(400).json({ error: '下载目录不能为空' });
    }

    // 确保目录存在
    try {
        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }
        writeConfig({ downloadDir });
        res.json({ success: true, downloadDir });
    } catch (err) {
        res.status(500).json({ error: `目录创建失败: ${err.message}` });
    }
});

/**
 * POST /api/parse — 解析抖音链接
 */
app.post('/api/parse', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: '请提供抖音视频链接' });
    }

    try {
        console.log(`[解析] 输入链接: ${url}`);

        // 1. 根据域名判断平台
        let info;
        if (url.includes('xhslink.com') || url.includes('xiaohongshu.com')) {
            console.log(`[解析] 检测到小红书链接`);
            info = await xhs.fetchXhsInfo(url);
        } else {
            console.log(`[解析] 检测到抖音链接`);
            // 1. 解析短链接
            const realUrl = await douyin.resolveShareUrl(url);
            console.log(`[解析] 真实链接: ${realUrl}`);

            // 2. 提取 video ID
            const videoId = douyin.extractVideoId(realUrl);
            console.log(`[解析] 视频 ID: ${videoId}`);

            // 3. 获取视频详情
            info = await douyin.fetchVideoInfo(videoId);
        }
        
        console.log(`[解析] 成功! 标题: ${info.title}, 类型: ${info.type}`);


        res.json({
            success: true,
            data: info,
        });
    } catch (err) {
        console.error(`[解析] 失败: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/download — 开始下载视频
 */
app.post('/api/download', async (req, res) => {
    const { videoUrl, title, awemeId, type, images } = req.body;
    let { platform } = req.body;
    const isImage = type === 'image';


    // 自动补全 platform，防止前端缓存了旧版 app.js 没传 platform 参数
    if (!platform && videoUrl) {
        if (videoUrl.includes('xhscdn.com') || videoUrl.includes('xiaohongshu.com')) {
            platform = 'xhs';
        }
    }

    console.log(`[下载] 收到请求: ${title}, 平台: ${platform || '未知'}, 类型: ${type}`);
    console.log(`[下载] URL: ${videoUrl || (images ? images[0] : '无')}`);


    const config = readConfig();
    let downloadDir = config.downloadDir;
    if (!downloadDir) {
        downloadDir = path.join(require('os').homedir(), 'Downloads', 'douyin');
    }

    // 确保下载目录存在
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    // 生成文件名或目录名
    const safeName = douyin.sanitizeFilename(title || awemeId || 'douyin');
    const fileName = isImage ? `[图集]_${safeName}` : `${safeName}_${awemeId || Date.now()}.mp4`;
    const savePath = path.join(downloadDir, fileName);

    // 创建下载任务
    const taskId = uuidv4();
    downloadTasks.set(taskId, {
        id: taskId,
        status: 'downloading',
        progress: 0,
        downloaded: 0,
        total: 0,
        filePath: savePath,
        fileName,
        title,
        error: null,
        startTime: Date.now(),
    });

    // 立即返回任务 ID
    res.json({ success: true, taskId });

    // 后台下载
    try {
        const referer = platform === 'xhs' ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/';
        console.log(`[下载] 最终使用 Referer: ${referer}`);
        let result;

        if (isImage) {
            result = await douyin.downloadImages(images, savePath, (progress, downloaded, total) => {
                const task = downloadTasks.get(taskId);
                if (task) {
                    task.progress = progress;
                    task.downloaded = downloaded;
                    task.total = total;
                }
            }, referer);
        } else {
            result = await douyin.downloadVideo(videoUrl, savePath, (progress, downloaded, total) => {
                const task = downloadTasks.get(taskId);
                if (task) {
                    task.progress = progress;
                    task.downloaded = downloaded;
                    task.total = total;
                }
            }, referer);
        }

        const task = downloadTasks.get(taskId);
        if (task) {
            task.status = 'done';
            task.progress = 100;
            task.fileSize = result.fileSize;
        }
        // 记录已下载的 awemeId（收藏同步用）
        if (awemeId) {
            try { favorites.saveSyncedIds([awemeId]); } catch (e) { }
        }
        console.log(`[下载] 完成: ${savePath} (${(result.fileSize / 1024 / 1024).toFixed(2)} MB)`);
    } catch (err) {
        const task = downloadTasks.get(taskId);
        if (task) {
            task.status = 'error';
            task.error = err.message;
        }
        console.error(`[下载] 失败: ${err.message}`);
    }
});

/**
 * GET /api/download/:taskId — 查询下载进度
 */
app.get('/api/download/:taskId', (req, res) => {
    const task = downloadTasks.get(req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

/**
 * GET /api/history — 获取下载历史（已完成的任务）
 */
app.get('/api/history', (req, res) => {
    const history = [];
    for (const task of downloadTasks.values()) {
        if (task.status === 'done') {
            history.push(task);
        }
    }
    // 按时间倒序
    history.sort((a, b) => b.startTime - a.startTime);
    res.json(history);
});

/**
 * POST /api/history/open — 打开本地文件
 */
app.post('/api/history/open', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: '未提供文件路径' });

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    const platform = process.platform;
    let command;

    if (platform === 'win32') {
        // Windows: 使用 explorer /select, "path" 打开文件夹并选中文件
        command = `explorer.exe /select,"${filePath}"`;
    } else if (platform === 'darwin') {
        // macOS: 使用 open -R 打开文件夹并选中文件
        command = `open -R "${filePath}"`;
    } else {
        // Linux: 使用 xdg-open 打开父目录
        command = `xdg-open "${path.dirname(filePath)}"`;
    }

    exec(command, (err) => {
        if (err) {
            console.error(`[打开文件] 失败: ${err.message}`);
            return res.status(500).json({ error: '文件夹打开失败' });
        }
        res.json({ success: true });
    });
});

/**
 * POST /api/history/delete — 删除本地文件
 */
app.post('/api/history/delete', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: '未提供文件路径' });

    try {
        if (fs.existsSync(filePath)) {
            // 如果是文件夹（图集），递归删除
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
            console.log(`[删除文件] 成功: ${filePath}`);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: '文件已不存在' });
        }
    } catch (err) {
        console.error(`[删除文件] 失败: ${err.message}`);
        res.status(500).json({ error: `删除失败: ${err.message}` });
    }
});

// ═══════════════════════════════════════════
// 收藏同步 API
// ═══════════════════════════════════════════

// 收藏同步任务存储
const favSyncTasks = new Map();

/**
 * GET /api/favorites/status — 获取登录状态和同步信息
 */
app.get('/api/favorites/status', (req, res) => {
    try {
        const status = favorites.checkLoginStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/favorites/login — 打开浏览器让用户扫码登录
 */
app.post('/api/favorites/login', async (req, res) => {
    try {
        // 先返回"正在打开浏览器"，不阻塞请求
        res.json({ success: true, message: '浏览器已打开，请在弹出的窗口中扫码登录' });

        // 后台执行登录（用户需要在弹出的浏览器中扫码）
        favorites.openLoginBrowser()
            .then(() => console.log('[收藏同步] 用户登录成功'))
            .catch(err => console.error('[收藏同步] 登录失败:', err.message));
    } catch (err) {
        // 如果还没发送响应
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

/**
 * POST /api/favorites/logout — 退出登录
 */
app.post('/api/favorites/logout', (req, res) => {
    try {
        const result = favorites.logout();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/favorites/sync — 获取收藏列表（只拉列表，不自动下载）
 */
app.post('/api/favorites/sync', async (req, res) => {
    const maxCount = req.body.maxCount || 50;

    // 检查是否已有同步任务在进行
    for (const task of favSyncTasks.values()) {
        if (task.status === 'fetching') {
            return res.status(409).json({ error: '已有同步任务进行中', taskId: task.id });
        }
    }

    const taskId = uuidv4();
    const task = {
        id: taskId,
        status: 'fetching',
        phase: '正在获取收藏列表...',
        collected: 0,
        maxCount,
        items: [],
        error: null,
        startTime: Date.now(),
    };
    favSyncTasks.set(taskId, task);

    res.json({ success: true, taskId });

    try {
        const rawItems = await favorites.fetchFavorites(maxCount, (collected, max, current) => {
            task.collected = collected;
            task.maxCount = max;
            task.current = current;
        });

        if (rawItems.length === 0) {
            task.status = 'done';
            task.phase = '收藏列表为空';
            return;
        }

        const syncedData = favorites.getSyncedData();
        const syncedIds = new Set(syncedData.ids || []);
        const config = readConfig();
        let downloadDir = config.downloadDir || path.join(require('os').homedir(), 'Downloads', 'douyin');

        for (const rawItem of rawItems) {
            try {
                const info = douyin.normalizeVideoData(rawItem);
                const awemeId = info.awemeId || '';
                const isImage = info.type === 'image';
                const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
                const fileName = isImage
                    ? `[图集]_${safeName}`
                    : `${safeName}_${awemeId || Date.now()}.mp4`;
                const savePath = path.join(downloadDir, fileName);
                const alreadyDownloaded = syncedIds.has(awemeId) || fs.existsSync(savePath);

                task.items.push({
                    type: info.type,
                    videoUrl: info.videoUrl,
                    images: info.images,
                    title: info.title,
                    author: info.author,
                    cover: info.cover,
                    awemeId,
                    duration: info.duration,
                    width: info.width,
                    height: info.height,
                    platform: 'douyin',
                    alreadyDownloaded,
                    fileName,
                    filePath: savePath,
                });
            } catch (err) {
                task.items.push({
                    title: rawItem.desc || '未知',
                    awemeId: rawItem.aweme_id || '',
                    cover: '',
                    parseError: err.message,
                    alreadyDownloaded: false,
                });
            }
        }

        task.status = 'done';
        task.phase = `已获取 ${task.items.length} 条收藏`;
        console.log(`[收藏同步] ${task.phase}`);
    } catch (err) {
        task.status = 'error';
        task.error = err.message;
        task.phase = '获取收藏列表失败';
        console.error(`[收藏同步] 错误: ${err.message}`);
    }
});

/**
 * GET /api/favorites/sync/:taskId — 查询同步任务进度
 */
app.get('/api/favorites/sync/:taskId', (req, res) => {
    const task = favSyncTasks.get(req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`\n🎬 抖音视频下载器已启动`);
    console.log(`📍 http://localhost:${PORT}\n`);
});
