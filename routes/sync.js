const express = require('express');
const router = express.Router();
const path = require('path');
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const douyin = require('../lib/douyin');
const favorites = require('../lib/douyin-favorites');
const configHelper = require('../lib/config');
const taskManager = require('../lib/task-manager');

/**
 * 规范化同步条数：必须是正整数，且上限 500，防止恶意/误传超大值
 * 导致 Playwright 长时间抓取、内存占用过大。
 */
function normalizeMaxCount(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 50;
}

// ═══════════════════════════════════════════
// 收藏同步 API
// ═══════════════════════════════════════════

router.get('/favorites/status', async (req, res) => {
    try {
        const status = await favorites.checkLoginStatus();
        status.qrCode = favorites.getLoginQr ? favorites.getLoginQr() : null;
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/favorites/login', async (req, res) => {
    try {
        res.json({ success: true, message: '浏览器已打开，请在弹出的窗口中扫码登录' });
        favorites.openLoginBrowser()
            .then(() => console.log('[收藏同步] 用户登录成功'))
            .catch(err => console.error('[收藏同步] 登录失败:', err.message));
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

router.post('/favorites/logout', async (req, res) => {
    try {
        const result = await favorites.logout();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/favorites/cookie-login', async (req, res) => {
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

router.post('/favorites/sync', async (req, res) => {
    const maxCount = normalizeMaxCount(req.body.maxCount);

    // 检查是否已有同步任务在进行
    const tasks = taskManager.getAllTasks('favSync');
    for (const task of tasks) {
        if (task.status === 'fetching') {
            return res.status(409).json({ error: '已有同步任务进行中', taskId: task.id });
        }
    }

    const taskId = uuidv4();
    await taskManager.createTask('favSync', taskId, {
        status: 'fetching',
        phase: '正在获取收藏列表...',
        collected: 0,
        maxCount,
        items: [],
        error: null,
        interrupted: false
    });

    res.json({ success: true, taskId });

    (async () => {
        try {
            const rawItems = await favorites.fetchFavorites(maxCount, async (collected, max, current) => {
                await taskManager.updateTask('favSync', taskId, { collected, maxCount: max, current });
            }, () => {
                const t = taskManager.getTask('favSync', taskId);
                return t ? t.interrupted : false;
            });

            const currentTask = taskManager.getTask('favSync', taskId);
            if (rawItems.length === 0) {
                await taskManager.updateTask('favSync', taskId, {
                    status: 'done',
                    phase: '收藏列表为空'
                });
                return;
            }

            const syncedData = await favorites.getSyncedData();
            const syncedIds = new Set(syncedData.ids || []);
            const downloadDir = await configHelper.getEffectiveDownloadDir();
            const items = [];

            for (const rawItem of rawItems) {
                try {
                    const info = douyin.normalizeVideoData(rawItem);
                    const awemeId = info.awemeId || '';
                    const isImage = info.type === 'image';
                    const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
                    // 与 routes/download.js 的落盘命名保持一致：实况图用 [实况图]_ 前缀，避免已下载检测错位
                    const isLivePhoto = isImage && Array.isArray(info.livePhotos) && info.livePhotos.length > 0;
                    const fileName = isImage
                        ? `${isLivePhoto ? '[实况图]_' : '[图集]_'}${safeName}`
                        : `${safeName}_${awemeId || Date.now()}.mp4`;
                    const savePath = path.join(downloadDir, fileName);
                    const alreadyDownloaded = syncedIds.has(awemeId) || fsSync.existsSync(savePath);

                    items.push({
                        type: info.type,
                        videoUrl: info.videoUrl,
                        images: info.images,
                        livePhotos: info.livePhotos || [],
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
                        filePath: savePath
                    });
                } catch (err) {
                    items.push({
                        title: rawItem.desc || '未知',
                        awemeId: rawItem.aweme_id || '',
                        cover: '',
                        parseError: err.message,
                        alreadyDownloaded: false
                    });
                }
            }

            const phaseText = currentTask.interrupted ? `已打断，获取到 ${items.length} 条收藏` : `已获取 ${items.length} 条收藏`;
            await taskManager.updateTask('favSync', taskId, {
                status: 'done',
                phase: phaseText,
                items,
                saveNow: true
            });
            console.log(`[收藏同步] ${phaseText}`);
        } catch (err) {
            await taskManager.updateTask('favSync', taskId, {
                status: 'error',
                error: err.message,
                phase: '获取收藏列表失败'
            });
            console.error(`[收藏同步] 错误: ${err.message}`);
        }
    })();
});

router.post('/favorites/sync/stop', async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: '未提供 taskId' });
    
    const task = taskManager.getTask('favSync', taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    if (task.status === 'fetching') {
        await taskManager.updateTask('favSync', taskId, { interrupted: true });
        console.log(`[收藏同步] 接收到打断信号 taskId=${taskId}`);
        return res.json({ success: true, message: '打断信号已发送' });
    }
    
    res.json({ success: false, message: '任务不在获取阶段，无法打断' });
});

router.get('/favorites/sync/:taskId', (req, res) => {
    const task = taskManager.getTask('favSync', req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

// ═══════════════════════════════════════════
// 喜欢同步 API
// ═══════════════════════════════════════════

router.post('/liked/sync', async (req, res) => {
    const maxCount = normalizeMaxCount(req.body.maxCount);

    const tasks = taskManager.getAllTasks('likedSync');
    for (const task of tasks) {
        if (task.status === 'fetching') {
            return res.status(409).json({ error: '已有同步任务进行中', taskId: task.id });
        }
    }

    const taskId = uuidv4();
    await taskManager.createTask('likedSync', taskId, {
        status: 'fetching',
        phase: '正在获取喜欢列表...',
        collected: 0,
        maxCount,
        items: [],
        error: null,
        interrupted: false
    });

    res.json({ success: true, taskId });

    (async () => {
        try {
            const rawItems = await favorites.fetchLikedVideos(maxCount, async (collected, max, current) => {
                await taskManager.updateTask('likedSync', taskId, { collected, maxCount: max, current });
            }, () => {
                const t = taskManager.getTask('likedSync', taskId);
                return t ? t.interrupted : false;
            });

            const currentTask = taskManager.getTask('likedSync', taskId);
            if (rawItems.length === 0) {
                await taskManager.updateTask('likedSync', taskId, {
                    status: 'done',
                    phase: '喜欢列表为空'
                });
                return;
            }

            const likedData = await favorites.getLikedData();
            const likedIds = new Set(likedData.ids || []);
            const downloadDir = await configHelper.getEffectiveDownloadDir();
            const items = [];

            for (const rawItem of rawItems) {
                try {
                    const info = douyin.normalizeVideoData(rawItem);
                    const awemeId = info.awemeId || '';
                    const isImage = info.type === 'image';
                    const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
                    // 与 routes/download.js 的落盘命名保持一致：实况图用 [实况图]_ 前缀，避免已下载检测错位
                    const isLivePhoto = isImage && Array.isArray(info.livePhotos) && info.livePhotos.length > 0;
                    const fileName = isImage
                        ? `${isLivePhoto ? '[实况图]_' : '[图集]_'}${safeName}`
                        : `${safeName}_${awemeId || Date.now()}.mp4`;
                    const savePath = path.join(downloadDir, fileName);
                    const alreadyDownloaded = likedIds.has(awemeId) || fsSync.existsSync(savePath);

                    items.push({
                        type: info.type,
                        videoUrl: info.videoUrl,
                        images: info.images,
                        livePhotos: info.livePhotos || [],
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
                        filePath: savePath
                    });
                } catch (err) {
                    items.push({
                        title: rawItem.desc || '未知',
                        awemeId: rawItem.aweme_id || '',
                        cover: '',
                        parseError: err.message,
                        alreadyDownloaded: false
                    });
                }
            }

            const phaseText = currentTask.interrupted ? `已打断，获取到 ${items.length} 条喜欢` : `已获取 ${items.length} 条喜欢`;
            await taskManager.updateTask('likedSync', taskId, {
                status: 'done',
                phase: phaseText,
                items,
                saveNow: true
            });
            console.log(`[喜欢同步] ${phaseText}`);
        } catch (err) {
            await taskManager.updateTask('likedSync', taskId, {
                status: 'error',
                error: err.message,
                phase: '获取喜欢列表失败'
            });
            console.error(`[喜欢同步] 错误: ${err.message}`);
        }
    })();
});

router.post('/liked/sync/stop', async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: '未提供 taskId' });
    
    const task = taskManager.getTask('likedSync', taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    if (task.status === 'fetching') {
        await taskManager.updateTask('likedSync', taskId, { interrupted: true });
        console.log(`[喜欢同步] 接收到打断信号 taskId=${taskId}`);
        return res.json({ success: true, message: '打断信号已发送' });
    }
    
    res.json({ success: false, message: '任务不在获取阶段，无法打断' });
});

router.get('/liked/sync/:taskId', (req, res) => {
    const task = taskManager.getTask('likedSync', req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

// ═══════════════════════════════════════════
// 私信同步 API
// ═══════════════════════════════════════════

router.post('/messages/sync', async (req, res) => {
    const maxCount = normalizeMaxCount(req.body.maxCount);

    const tasks = taskManager.getAllTasks('msgSync');
    for (const task of tasks) {
        if (task.status === 'fetching') {
            return res.status(409).json({ error: '已有同步任务进行中', taskId: task.id });
        }
    }

    const taskId = uuidv4();
    await taskManager.createTask('msgSync', taskId, {
        status: 'fetching',
        phase: '正在初始化...',
        collected: 0,
        maxCount,
        items: [],
        error: null,
        interrupted: false
    });

    res.json({ success: true, taskId });

    (async () => {
        try {
            const rawItems = await favorites.fetchMessageVideos(maxCount, async (progress) => {
                await taskManager.updateTask('msgSync', taskId, {
                    phase: progress.phase,
                    collected: progress.collected
                });
            }, () => {
                const t = taskManager.getTask('msgSync', taskId);
                return t ? t.interrupted : false;
            });

            const currentTask = taskManager.getTask('msgSync', taskId);
            if (rawItems.length === 0) {
                await taskManager.updateTask('msgSync', taskId, {
                    status: 'done',
                    phase: '未在私信中发现视频'
                });
                return;
            }

            const downloadDir = await configHelper.getEffectiveDownloadDir();
            const items = [];

            for (const rawItem of rawItems) {
                try {
                    const info = rawItem;
                    const awemeId = info.awemeId || '';
                    const isImage = info.type === 'image';
                    const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
                    // 与 routes/download.js 的落盘命名保持一致：实况图用 [实况图]_ 前缀，避免已下载检测错位
                    const isLivePhoto = isImage && Array.isArray(info.livePhotos) && info.livePhotos.length > 0;
                    const fileName = isImage
                        ? `${isLivePhoto ? '[实况图]_' : '[图集]_'}${safeName}`
                        : `${safeName}_${awemeId || Date.now()}.mp4`;
                    const savePath = path.join(downloadDir, fileName);
                    const alreadyDownloaded = fsSync.existsSync(savePath);

                    items.push({
                        type: info.type,
                        videoUrl: info.videoUrl,
                        images: info.images,
                        livePhotos: info.livePhotos || [],
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
                        filePath: savePath
                    });
                } catch (err) {
                    items.push({
                        title: rawItem.title || '未知',
                        awemeId: rawItem.awemeId || '',
                        cover: '',
                        parseError: err.message,
                        alreadyDownloaded: false
                    });
                }
            }

            const phaseText = currentTask.interrupted ? `已打断，获取到 ${items.length} 条私信视频` : `已获取 ${items.length} 条私信视频`;
            await taskManager.updateTask('msgSync', taskId, {
                status: 'done',
                phase: phaseText,
                items,
                saveNow: true
            });
            console.log(`[私信同步] ${phaseText}`);
        } catch (err) {
            await taskManager.updateTask('msgSync', taskId, {
                status: 'error',
                error: err.message,
                phase: '获取私信视频列表失败'
            });
            console.error(`[私信同步] 错误: ${err.message}`);
        }
    })();
});

router.post('/messages/sync/stop', async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: '未提供 taskId' });
    
    const task = taskManager.getTask('msgSync', taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    if (task.status === 'fetching') {
        await taskManager.updateTask('msgSync', taskId, { interrupted: true });
        console.log(`[私信同步] 接收到打断信号 taskId=${taskId}`);
        return res.json({ success: true, message: '打断信号已发送' });
    }
    
    res.json({ success: false, message: '任务不在获取阶段，无法打断' });
});

router.get('/messages/sync/:taskId', (req, res) => {
    const task = taskManager.getTask('msgSync', req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

// ═══════════════════════════════════════════
// 用户主页同步 API
// ═══════════════════════════════════════════

router.post('/user/sync', async (req, res) => {
    const { secUid } = req.body;
    const maxCount = normalizeMaxCount(req.body.maxCount);
    const tabType = req.body.tabType || 'post';

    // 仅支持 post 和 like（抖音 web 端不支持查看他人收藏/收藏夹）
    if (tabType !== 'post' && tabType !== 'like') {
        return res.status(400).json({ error: '不支持的同步类型，抖音网页版仅支持同步作品和公开喜欢' });
    }

    const tabLabel = tabType === 'like' ? '喜欢视频' : '作品';

    if (!secUid) return res.status(400).json({ error: '请提供 secUid' });
    // secUid 格式校验：应为字母数字下划线横线点组成
    if (!/^[a-zA-Z0-9_\-\.]{10,}$/.test(secUid)) {
        return res.status(400).json({ error: 'secUid 格式不正确' });
    }

    const tasks = taskManager.getAllTasks('userSync');
    for (const task of tasks) {
        if (task.status === 'fetching') {
            return res.status(409).json({ error: '已有用户同步任务进行中', taskId: task.id });
        }
    }

    const taskId = uuidv4();
    await taskManager.createTask('userSync', taskId, {
        status: 'fetching',
        phase: `正在获取用户${tabLabel}...`,
        collected: 0,
        maxCount,
        tabType,
        items: [],
        error: null,
        interrupted: false,
        nickname: '抖音用户'
    });

    res.json({ success: true, taskId });

    (async () => {
        try {
            const progressCb = async (collected, max, current) => {
                const updates = { collected, maxCount: max };
                if (current && current.nickname) {
                    updates.nickname = current.nickname;
                }
                if (current && current.title) {
                    updates.phase = current.title;
                }
                await taskManager.updateTask('userSync', taskId, updates);
            };
            const interruptCb = () => {
                const t = taskManager.getTask('userSync', taskId);
                return t ? t.interrupted : false;
            };

            const result = await favorites.fetchUserPosts(secUid, maxCount, progressCb, interruptCb, tabType);

            const currentTask = taskManager.getTask('userSync', taskId);
            const rawItems = result.items;
            const nickname = result.nickname;

            if (rawItems.length === 0) {
                await taskManager.updateTask('userSync', taskId, {
                    status: 'done',
                    phase: `${tabLabel}列表为空`,
                    nickname
                });
                return;
            }

            const downloadDir = await configHelper.getEffectiveDownloadDir();
            const items = [];

            for (const rawItem of rawItems) {
                try {
                    const info = douyin.normalizeVideoData(rawItem);
                    const awemeId = info.awemeId || '';
                    const isImage = info.type === 'image';
                    const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
                    // 与 routes/download.js 的落盘命名保持一致：实况图用 [实况图]_ 前缀，避免已下载检测错位
                    const isLivePhoto = isImage && Array.isArray(info.livePhotos) && info.livePhotos.length > 0;
                    const fileName = isImage
                        ? `${isLivePhoto ? '[实况图]_' : '[图集]_'}${safeName}`
                        : `${safeName}_${awemeId || Date.now()}.mp4`;
                    const savePath = path.join(downloadDir, fileName);
                    
                    // 判断是否已下载：只检查当前用户历史批量下载目录
                    // 根目录里的文件可能来自其他用户的单独下载，不应污染当前用户结果
                    let alreadyDownloaded = false;
                    try {
                        const dirs = fsSync.readdirSync(downloadDir, { withFileTypes: true });
                        for (const d of dirs) {
                            if (!d.isDirectory() || !d.name.startsWith(nickname)) continue;
                            if (fsSync.existsSync(path.join(downloadDir, d.name, fileName))) {
                                alreadyDownloaded = true;
                                break;
                            }
                        }
                    } catch (e) {}

                    items.push({
                        type: info.type,
                        videoUrl: info.videoUrl,
                        images: info.images,
                        livePhotos: info.livePhotos || [],
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
                        filePath: savePath
                    });
                } catch (err) {
                    items.push({
                        title: rawItem.desc || '未知',
                        awemeId: rawItem.aweme_id || '',
                        cover: '',
                        parseError: err.message,
                        alreadyDownloaded: false
                    });
                }
            }

            const phaseText = currentTask.interrupted ? `已打断，获取到 ${items.length} 条${tabLabel}` : `已获取 ${nickname} 的 ${items.length} 条${tabLabel}`;
            await taskManager.updateTask('userSync', taskId, {
                status: 'done',
                phase: phaseText,
                items,
                nickname,
                saveNow: true
            });
            console.log(`[用户同步] ${phaseText}`);
        } catch (err) {
            await taskManager.updateTask('userSync', taskId, {
                status: 'error',
                error: err.message,
                phase: `获取${tabLabel}列表失败`
            });
            console.error(`[用户同步] 错误: ${err.message}`);
        }
    })();
});

router.post('/user/sync/stop', async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: '未提供 taskId' });
    
    const task = taskManager.getTask('userSync', taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    if (task.status === 'fetching') {
        await taskManager.updateTask('userSync', taskId, { interrupted: true });
        console.log(`[用户同步] 接收到打断信号 taskId=${taskId}`);
        return res.json({ success: true, message: '打断信号已发送' });
    }
    
    res.json({ success: false, message: '任务不在获取阶段，无法打断' });
});

router.get('/user/sync/:taskId', (req, res) => {
    const task = taskManager.getTask('userSync', req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

module.exports = router;
