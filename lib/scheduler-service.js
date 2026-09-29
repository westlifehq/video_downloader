const path = require('path');
const cron = require('node-cron');
const douyin = require('./douyin');
const favorites = require('./douyin-favorites');
const configHelper = require('./config');

let scheduledTask = null;
let randomTimer = null;
let runningScheduledSync = null;
let scheduledSyncRunner = executeScheduledSync;

async function executeScheduledSync() {
    const config = await configHelper.readScheduleConfig();
    const logEntry = { time: new Date().toISOString(), syncMode: config.syncMode, maxCount: config.maxCount, results: [], error: null };

    console.log(`[定时同步] 开始执行，模式=${config.syncMode}，最多=${config.maxCount}条`);

    const loginStatus = await favorites.checkLoginStatus();
    if (!loginStatus.loggedIn) {
        logEntry.error = '未登录，跳过定时同步';
        await configHelper.appendScheduleLog(logEntry);
        console.log('[定时同步] 未登录，跳过');
        return logEntry;
    }

    const downloadDir = await configHelper.getEffectiveDownloadDir();
    const fsSync = require('fs');
    if (!fsSync.existsSync(downloadDir)) {
        const fs = require('fs').promises;
        await fs.mkdir(downloadDir, { recursive: true });
    }

    const syncedData = await favorites.getSyncedData();
    const likedData = await favorites.getLikedData();
    const allDownloadedIds = new Set([...(syncedData.ids || []), ...(likedData.ids || [])]);

    const allItems = [];

    const shouldSyncFav = ['favorites', 'both', 'all'].includes(config.syncMode);
    const shouldSyncLiked = ['liked', 'both', 'all'].includes(config.syncMode);
    const shouldSyncMessages = ['messages', 'all'].includes(config.syncMode);

    try {
        if (shouldSyncFav) {
            const favRaw = await favorites.fetchFavorites(config.maxCount, null, null, 'favorite');
            for (const raw of favRaw) {
                try { allItems.push({ info: douyin.normalizeVideoData(raw), source: 'favorite' }); } catch (e) { }
            }
        }
        if (shouldSyncLiked) {
            const likedRaw = await favorites.fetchLikedVideos(config.maxCount, null, null);
            for (const raw of likedRaw) {
                try { allItems.push({ info: douyin.normalizeVideoData(raw), source: 'liked' }); } catch (e) { }
            }
        }
        if (shouldSyncMessages) {
            console.log('[定时同步] 开始私信同步...');
            const msgItems = await favorites.fetchMessageVideos(config.maxCount, (progress) => {
                console.log(`[定时同步] 私信: ${progress.phase}`);
            }, () => false);
            for (const item of msgItems) {
                try { allItems.push({ info: item, source: 'messages' }); } catch (e) { }
            }
        }
    } catch (err) {
        logEntry.error = `同步阶段出错: ${err.message}`;
        await configHelper.appendScheduleLog(logEntry);
        return logEntry;
    }

    const seenIds = new Set();
    const toDownload = [];
    for (const { info } of allItems) {
        const awemeId = info.awemeId || '';
        if (!awemeId || seenIds.has(awemeId) || allDownloadedIds.has(awemeId)) continue;
        seenIds.add(awemeId);
        const isImage = info.type === 'image';
        const isLivePhoto = isImage && Array.isArray(info.livePhotos) && info.livePhotos.length > 0;
        const folderPrefix = isLivePhoto ? '[实况图]_' : '[图集]_';
        const safeName = douyin.sanitizeFilename(info.title || awemeId || 'douyin');
        const fileName = isImage ? `${folderPrefix}${safeName}` : `${safeName}_${awemeId || Date.now()}.mp4`;
        const savePath = path.join(downloadDir, fileName);
        if (fsSync.existsSync(savePath)) continue;
        toDownload.push({ info, fileName, savePath });
    }

    logEntry.totalFound = allItems.length;
    logEntry.toDownload = toDownload.length;

    let successCount = 0, failCount = 0;
    for (const { info, fileName, savePath } of toDownload) {
        try {
            const referer = 'https://www.douyin.com/';
            if (info.type === 'image') {
                await douyin.downloadImages(info.images, savePath, null, referer, info.livePhotos);
            } else {
                await douyin.downloadVideo(info.videoUrl, savePath, null, referer);
            }
            if (info.awemeId) {
                try { await favorites.saveSyncedIds([info.awemeId]); } catch (e) { }
                try { await favorites.saveLikedIds([info.awemeId]); } catch (e) { }
            }
            successCount++;
        } catch (err) {
            failCount++;
        }
    }

    logEntry.results = { success: successCount, fail: failCount };
    await configHelper.appendScheduleLog(logEntry);
    return logEntry;
}

/**
 * 执行定时同步
 */
async function runScheduledSync() {
    if (runningScheduledSync) {
        throw new Error('定时同步任务正在执行中');
    }
    runningScheduledSync = (async () => scheduledSyncRunner())();
    try {
        return await runningScheduledSync;
    } finally {
        runningScheduledSync = null;
    }
}

function __setScheduledSyncRunnerForTest(fn) {
    scheduledSyncRunner = fn || executeScheduledSync;
}

/**
 * 启动定时同步任务
 */
function startScheduledTask() {
    if (scheduledTask) { scheduledTask.stop(); scheduledTask = null; }
    if (randomTimer) { clearTimeout(randomTimer); randomTimer = null; }
    const config = configHelper.readScheduleConfigSync();
    if (!config.enabled) { console.log('[定时同步] 已禁用'); return; }
    if (config.triggerMode === 'random') {
        scheduledTask = cron.schedule('0 0 * * *', () => { scheduleRandomExecution(config); }, { timezone: 'Asia/Shanghai' });
        scheduleRandomExecution(config);
        console.log(`[定时同步] 随机模式启动，范围 ${config.rangeStart || '00:00'}-${config.rangeEnd || '06:00'}`);
    } else {
        if (!cron.validate(config.cronTime)) { console.error(`[定时同步] cron 表达式无效: ${config.cronTime}`); return; }
        scheduledTask = cron.schedule(config.cronTime, () => { runScheduledSync().catch(err => console.error('[定时同步] 执行出错:', err.message)); }, { timezone: 'Asia/Shanghai' });
        console.log(`[定时同步] 固定模式启动，cron="${config.cronTime}", 模式="${config.syncMode}", 最多=${config.maxCount}条`);
    }
}

/**
 * 随机调度执行时间
 */
function scheduleRandomExecution(config) {
    if (randomTimer) { clearTimeout(randomTimer); randomTimer = null; }
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const [startH, startM] = (config.rangeStart || '00:00').split(':').map(Number);
    const [endH, endM] = (config.rangeEnd || '06:00').split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (nowMinutes >= endMinutes) {
        console.log(`[定时同步] 当前北京时间 ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} 已过执行窗口，等待明日触发`);
        return;
    }
    const rangeFrom = Math.max(startMinutes, nowMinutes + 1);
    if (rangeFrom >= endMinutes) return;
    const randomMinute = rangeFrom + Math.floor(Math.random() * (endMinutes - rangeFrom));
    const delayMs = (randomMinute - nowMinutes) * 60 * 1000;
    console.log(`[定时同步] 随机触发安排在北京时间 ${String(Math.floor(randomMinute/60)).padStart(2,'0')}:${String(randomMinute%60).padStart(2,'0')}（${Math.round(delayMs/60000)}分钟后）`);
    randomTimer = setTimeout(() => { runScheduledSync().catch(err => console.error('[定时同步] 随机执行出错:', err.message)); }, delayMs);
}

module.exports = {
    runScheduledSync,
    startScheduledTask,
    __setScheduledSyncRunnerForTest
};
