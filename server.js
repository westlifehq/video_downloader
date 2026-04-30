const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
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
 * 获取当前的有效下载目录 (优先级：环境变量 > 配置文件 > 默认路径)
 */
function getEffectiveDownloadDir() {
    const config = readConfig();
    if (process.env.DOWNLOAD_DIR) {
        return process.env.DOWNLOAD_DIR;
    }
    if (config.downloadDir) {
        return config.downloadDir;
    }
    return path.join(require('os').homedir(), 'Downloads', 'douyin');
}

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
    // 返回包含当前有效路径的配置
    res.json({
        ...config,
        downloadDir: getEffectiveDownloadDir()
    });
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

    const downloadDir = getEffectiveDownloadDir();

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
        // 记录已下载的 awemeId（收藏同步 + 喜欢同步用）
        if (awemeId) {
            try { favorites.saveSyncedIds([awemeId]); } catch (e) { }
            try { favorites.saveLikedIds([awemeId]); } catch (e) { }
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
        // 如果正在登录中，尝试获取二维码
        status.qrCode = favorites.getLoginQr ? favorites.getLoginQr() : null;
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
app.post('/api/favorites/logout', async (req, res) => {
    try {
        const result = await favorites.logout();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/favorites/cookie-login — 手动注入 Cookie
 */
app.post('/api/favorites/cookie-login', async (req, res) => {
    try {
        const { cookie } = req.body;
        if (!cookie) {
            return res.status(400).json({ error: '请提供 Cookie' });
        }
        await favorites.loginWithCookie(cookie);
        res.json({ success: true });
    } catch (err) {
        console.error('Cookie 注入失败:', err);
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
        interrupted: false,
    };
    favSyncTasks.set(taskId, task);

    res.json({ success: true, taskId });

    try {
        const rawItems = await favorites.fetchFavorites(maxCount, (collected, max, current) => {
            task.collected = collected;
            task.maxCount = max;
            task.current = current;
        }, () => task.interrupted);

        if (rawItems.length === 0) {
            task.status = 'done';
            task.phase = '收藏列表为空';
            return;
        }

        const syncedData = favorites.getSyncedData();
        const syncedIds = new Set(syncedData.ids || []);
        
        // 确定下载目录逻辑
        const downloadDir = getEffectiveDownloadDir();
        
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
        task.phase = task.interrupted ? `已打断，获取到 ${task.items.length} 条收藏` : `已获取 ${task.items.length} 条收藏`;
        console.log(`[收藏同步] ${task.phase}`);
    } catch (err) {
        task.status = 'error';
        task.error = err.message;
        task.phase = '获取收藏列表失败';
        console.error(`[收藏同步] 错误: ${err.message}`);
    }
});

/**
 * POST /api/favorites/sync/stop — 打断同步任务
 */
app.post('/api/favorites/sync/stop', (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: '未提供 taskId' });
    
    const task = favSyncTasks.get(taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    if (task.status === 'fetching') {
        task.interrupted = true;
        console.log(`[收藏同步] 接收到打断信号 taskId=${taskId}`);
        return res.json({ success: true, message: '打断信号已发送' });
    }
    
    res.json({ success: false, message: '任务不在获取阶段，无法打断' });
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

// ═══════════════════════════════════════════
// 喜欢同步 API
// ═══════════════════════════════════════════

const likedSyncTasks = new Map();

/**
 * POST /api/liked/sync — 获取喜欢列表（只拉列表，不自动下载）
 */
app.post('/api/liked/sync', async (req, res) => {
    const maxCount = req.body.maxCount || 50;

    // 检查是否已有同步任务在进行
    for (const task of likedSyncTasks.values()) {
        if (task.status === 'fetching') {
            return res.status(409).json({ error: '已有同步任务进行中', taskId: task.id });
        }
    }

    const taskId = uuidv4();
    const task = {
        id: taskId,
        status: 'fetching',
        phase: '正在获取喜欢列表...',
        collected: 0,
        maxCount,
        items: [],
        error: null,
        startTime: Date.now(),
        interrupted: false,
    };
    likedSyncTasks.set(taskId, task);

    res.json({ success: true, taskId });

    try {
        const rawItems = await favorites.fetchLikedVideos(maxCount, (collected, max, current) => {
            task.collected = collected;
            task.maxCount = max;
            task.current = current;
        }, () => task.interrupted);

        if (rawItems.length === 0) {
            task.status = 'done';
            task.phase = '喜欢列表为空';
            return;
        }

        const likedData = favorites.getLikedData();
        const likedIds = new Set(likedData.ids || []);
        
        const downloadDir = getEffectiveDownloadDir();
        
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
                const alreadyDownloaded = likedIds.has(awemeId) || fs.existsSync(savePath);

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
        task.phase = task.interrupted ? `已打断，获取到 ${task.items.length} 条喜欢` : `已获取 ${task.items.length} 条喜欢`;
        console.log(`[喜欢同步] ${task.phase}`);
    } catch (err) {
        task.status = 'error';
        task.error = err.message;
        task.phase = '获取喜欢列表失败';
        console.error(`[喜欢同步] 错误: ${err.message}`);
    }
});

/**
 * POST /api/liked/sync/stop — 打断喜欢同步任务
 */
app.post('/api/liked/sync/stop', (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: '未提供 taskId' });
    
    const task = likedSyncTasks.get(taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    if (task.status === 'fetching') {
        task.interrupted = true;
        console.log(`[喜欢同步] 接收到打断信号 taskId=${taskId}`);
        return res.json({ success: true, message: '打断信号已发送' });
    }
    
    res.json({ success: false, message: '任务不在获取阶段，无法打断' });
});

/**
 * GET /api/liked/sync/:taskId — 查询喜欢同步任务进度
 */
app.get('/api/liked/sync/:taskId', (req, res) => {
    const task = likedSyncTasks.get(req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

// ═══════════════════════════════════════════
// 定时同步 & 下载
// ═══════════════════════════════════════════

const SCHEDULE_CONFIG_PATH = path.join(exeDir, 'schedule_config.json');
const SCHEDULE_LOG_PATH = path.join(exeDir, 'schedule_log.json');

function readScheduleConfig() {
    try { return JSON.parse(fs.readFileSync(SCHEDULE_CONFIG_PATH, 'utf-8')); }
    catch { return { enabled: false, cronTime: '0 0 * * *', syncMode: 'both', maxCount: 50 }; }
}

function writeScheduleConfig(cfg) {
    fs.writeFileSync(SCHEDULE_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function readScheduleLog() {
    try { return JSON.parse(fs.readFileSync(SCHEDULE_LOG_PATH, 'utf-8')); }
    catch { return []; }
}

function appendScheduleLog(entry) {
    const logs = readScheduleLog();
    logs.unshift(entry);
    // 只保留最近 50 条
    fs.writeFileSync(SCHEDULE_LOG_PATH, JSON.stringify(logs.slice(0, 50), null, 2));
}

let scheduledTask = null;

/**
 * 执行定时同步 + 下载
 */
async function runScheduledSync() {
    const config = readScheduleConfig();
    const logEntry = { time: new Date().toISOString(), syncMode: config.syncMode, maxCount: config.maxCount, results: [], error: null };

    console.log(`[定时同步] 开始执行，模式=${config.syncMode}，最多=${config.maxCount}条`);

    if (!favorites.checkLoginStatus().loggedIn) {
        logEntry.error = '未登录，跳过定时同步';
        appendScheduleLog(logEntry);
        console.log('[定时同步] 未登录，跳过');
        return logEntry;
    }

    const downloadDir = getEffectiveDownloadDir();
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    // 收集所有已下载 ID（用于跨收藏/喜欢去重）
    const syncedData = favorites.getSyncedData();
    const likedData = favorites.getLikedData();
    const allDownloadedIds = new Set([...(syncedData.ids || []), ...(likedData.ids || [])]);

    const allItems = []; // { info, source }

    try {
        // 收藏同步
        if (config.syncMode === 'favorites' || config.syncMode === 'both') {
            console.log('[定时同步] 正在获取收藏列表...');
            const favRaw = await favorites.fetchFavorites(config.maxCount, null, null, 'favorite');
            for (const raw of favRaw) {
                try {
                    const info = douyin.normalizeVideoData(raw);
                    allItems.push({ info, source: 'favorite' });
                } catch (e) { /* skip */ }
            }
            console.log(`[定时同步] 收藏获取 ${favRaw.length} 条`);
        }

        // 喜欢同步
        if (config.syncMode === 'liked' || config.syncMode === 'both') {
            console.log('[定时同步] 正在获取喜欢列表...');
            const likedRaw = await favorites.fetchLikedVideos(config.maxCount, null, null);
            for (const raw of likedRaw) {
                try {
                    const info = douyin.normalizeVideoData(raw);
                    allItems.push({ info, source: 'liked' });
                } catch (e) { /* skip */ }
            }
            console.log(`[定时同步] 喜欢获取 ${likedRaw.length} 条`);
        }
    } catch (err) {
        logEntry.error = `同步阶段出错: ${err.message}`;
        appendScheduleLog(logEntry);
        console.error('[定时同步] 同步阶段出错:', err.message);
        return logEntry;
    }

    // 去重：按 awemeId 去重，跳过已下载
    const seenIds = new Set();
    const toDownload = [];
    for (const { info } of allItems) {
        const awemeId = info.awemeId || '';
        if (!awemeId || seenIds.has(awemeId) || allDownloadedIds.has(awemeId)) continue;
        seenIds.add(awemeId);
        // 检查文件是否已存在
        const isImage = info.type === 'image';
        const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
        const fileName = isImage ? `[图集]_${safeName}` : `${safeName}_${awemeId || Date.now()}.mp4`;
        const savePath = path.join(downloadDir, fileName);
        if (fs.existsSync(savePath)) continue;
        toDownload.push({ info, fileName, savePath });
    }

    console.log(`[定时同步] 去重后需下载 ${toDownload.length} 条`);
    logEntry.totalFound = allItems.length;
    logEntry.toDownload = toDownload.length;

    // 逐条下载
    let successCount = 0, failCount = 0;
    for (const { info, fileName, savePath } of toDownload) {
        try {
            const referer = 'https://www.douyin.com/';
            const isImage = info.type === 'image';
            if (isImage) {
                await douyin.downloadImages(info.images, savePath, null, referer);
            } else {
                await douyin.downloadVideo(info.videoUrl, savePath, null, referer);
            }
            // 标记已下载
            const awemeId = info.awemeId;
            if (awemeId) {
                try { favorites.saveSyncedIds([awemeId]); } catch (e) { }
                try { favorites.saveLikedIds([awemeId]); } catch (e) { }
            }
            successCount++;
            console.log(`[定时同步] ✓ 下载完成: ${fileName}`);
        } catch (err) {
            failCount++;
            console.error(`[定时同步] ✕ 下载失败: ${info.title} - ${err.message}`);
        }
    }

    logEntry.results = { success: successCount, fail: failCount };
    appendScheduleLog(logEntry);
    console.log(`[定时同步] 完成: 成功=${successCount}, 失败=${failCount}`);
    return logEntry;
}

/**
 * 启动/重启定时任务（支持固定模式和随机时段模式）
 */
let randomTimer = null;
function startScheduledTask() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
    }
    if (randomTimer) {
        clearTimeout(randomTimer);
        randomTimer = null;
    }

    const config = readScheduleConfig();
    if (!config.enabled) {
        console.log('[定时同步] 已禁用');
        return;
    }

    if (config.triggerMode === 'random') {
        // 随机时段模式：每天0点调度一次，随机选取 rangeStart ~ rangeEnd 之间的时间执行
        scheduledTask = cron.schedule('0 0 * * *', () => {
            scheduleRandomExecution(config);
        });
        // 如果今天还在范围内，也立即安排
        scheduleRandomExecution(config);
        console.log(`[定时同步] 随机模式启动，范围 ${config.rangeStart || '00:00'}-${config.rangeEnd || '06:00'}`);
    } else {
        // 固定时间模式
        if (!cron.validate(config.cronTime)) {
            console.error(`[定时同步] cron 表达式无效: ${config.cronTime}`);
            return;
        }
        scheduledTask = cron.schedule(config.cronTime, () => {
            runScheduledSync().catch(err => {
                console.error('[定时同步] 执行出错:', err.message);
            });
        });
        console.log(`[定时同步] 固定模式启动，cron="${config.cronTime}", 模式="${config.syncMode}", 最多=${config.maxCount}条`);
    }
}

function scheduleRandomExecution(config) {
    const now = new Date();
    const [startH, startM] = (config.rangeStart || '00:00').split(':').map(Number);
    const [endH, endM] = (config.rangeEnd || '06:00').split(':').map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // 如果已经超过结束时间，今天不再执行
    if (nowMinutes >= endMinutes) return;

    // 从 max(startMinutes, nowMinutes) 到 endMinutes 之间随机选取
    const rangeFrom = Math.max(startMinutes, nowMinutes + 1);
    if (rangeFrom >= endMinutes) return;

    const randomMinute = rangeFrom + Math.floor(Math.random() * (endMinutes - rangeFrom));
    const delayMs = (randomMinute - nowMinutes) * 60 * 1000;

    const execHour = String(Math.floor(randomMinute / 60)).padStart(2, '0');
    const execMin = String(randomMinute % 60).padStart(2, '0');
    console.log(`[定时同步] 随机触发安排在今天 ${execHour}:${execMin}（约${Math.round(delayMs / 60000)}分钟后）`);

    randomTimer = setTimeout(() => {
        runScheduledSync().catch(err => {
            console.error('[定时同步] 随机执行出错:', err.message);
        });
    }, delayMs);
}

/**
 * GET /api/schedule/config — 获取定时同步配置
 */
app.get('/api/schedule/config', (req, res) => {
    res.json(readScheduleConfig());
});

/**
 * POST /api/schedule/config — 保存定时同步配置并重启任务
 */
app.post('/api/schedule/config', (req, res) => {
    const { enabled, cronTime, syncMode, maxCount, triggerMode, rangeStart, rangeEnd } = req.body;
    const cfg = readScheduleConfig();

    if (typeof enabled === 'boolean') cfg.enabled = enabled;
    if (cronTime !== undefined) {
        if (!cron.validate(cronTime)) {
            return res.status(400).json({ error: `无效的 cron 表达式: ${cronTime}` });
        }
        cfg.cronTime = cronTime;
    }
    if (syncMode && ['favorites', 'liked', 'both'].includes(syncMode)) cfg.syncMode = syncMode;
    if (maxCount && Number.isInteger(maxCount) && maxCount > 0 && maxCount <= 500) cfg.maxCount = maxCount;
    if (triggerMode && ['fixed', 'random'].includes(triggerMode)) cfg.triggerMode = triggerMode;
    if (rangeStart) cfg.rangeStart = rangeStart;
    if (rangeEnd) cfg.rangeEnd = rangeEnd;

    writeScheduleConfig(cfg);
    startScheduledTask();
    res.json({ success: true, config: cfg });
});

/**
 * GET /api/schedule/logs — 获取定时同步执行日志
 */
app.get('/api/schedule/logs', (req, res) => {
    res.json(readScheduleLog());
});

/**
 * POST /api/schedule/run — 手动触发一次定时同步
 */
app.post('/api/schedule/run', async (req, res) => {
    res.json({ success: true, message: '已触发定时同步' });
    runScheduledSync().catch(err => {
        console.error('[定时同步] 手动触发执行出错:', err.message);
    });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`\n🎬 抖音视频下载器已启动`);
    console.log(`📍 http://localhost:${PORT}\n`);
    // 启动定时任务
    startScheduledTask();
});
