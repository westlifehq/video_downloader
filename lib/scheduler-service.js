const path = require('path');
const cron = require('node-cron');
const douyin = require('./douyin');
const favorites = require('./douyin-favorites');
const configHelper = require('./config');

let scheduledTask = null;
let randomTimer = null;
let runningScheduledSync = null;
let scheduledSyncRunner = executeScheduledSync;
let retryDelayMs = 3 * 60 * 1000;

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

    // 同步阶段按来源独立重试：偶发 goto 超时/网络抖动不该让整个凌晨任务作废
    // （2026-10-22 04:09 曾因 chat 页 goto 超时 30s 直接失败且无重试）。
    // 原实现三个来源共用一个重试事务，任一来源失败就清空已抓到的结果重来，最终失败则全部丢弃。
    const MAX_ATTEMPTS = 3;
    const sources = [];
    if (shouldSyncFav) sources.push({ label: '收藏', run: async () => {
        const raw = await favorites.fetchFavorites(config.maxCount, null, null, 'favorite');
        return raw.map(r => { try { return douyin.normalizeVideoData(r); } catch (e) { return null; } }).filter(Boolean);
    } });
    if (shouldSyncLiked) sources.push({ label: '喜欢', run: async () => {
        const raw = await favorites.fetchLikedVideos(config.maxCount, null, null);
        return raw.map(r => { try { return douyin.normalizeVideoData(r); } catch (e) { return null; } }).filter(Boolean);
    } });
    if (shouldSyncMessages) sources.push({ label: '私信', run: async () => {
        console.log('[定时同步] 开始私信同步...');
        return favorites.fetchMessageVideos(config.maxCount, (progress) => {
            console.log(`[定时同步] 私信: ${progress.phase}`);
        }, () => false);
    } });

    const sourceErrors = [];
    for (const source of sources) {
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const infos = await source.run();
                for (const info of infos) allItems.push({ info, source: source.label });
                lastError = null;
                break;
            } catch (err) {
                lastError = err.message;
                console.log(`[定时同步] ${source.label} 第 ${attempt}/${MAX_ATTEMPTS} 次尝试失败: ${lastError}`);
                if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }
        if (lastError) sourceErrors.push(`${source.label}: ${lastError}`);
    }
    if (sourceErrors.length) {
        const summary = `同步阶段出错（已重试 ${MAX_ATTEMPTS - 1} 次）: ${sourceErrors.join('；')}`;
        if (sourceErrors.length === sources.length) {
            logEntry.error = summary;
            await configHelper.appendScheduleLog(logEntry);
            return logEntry;
        }
        // 部分来源失败：成功来源照常进入下载，失败原因记入日志
        logEntry.partialError = summary;
    }

    const seenIds = new Set();
    const toDownload = [];
    for (const { info } of allItems) {
        const awemeId = info.awemeId || '';
        if (!awemeId || seenIds.has(awemeId) || allDownloadedIds.has(awemeId)) continue;
        seenIds.add(awemeId);
        const fileName = douyin.buildDownloadName(info);
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
            console.log(`[定时同步] 下载失败 ${info.awemeId || ''} ${info.title || ''}: ${err.message}`);
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

function __setRetryDelayForTest(ms) {
    retryDelayMs = ms;
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
        // 每天在窗口起点触发一次随机安排（窗口可跨午夜，如 23:00-02:00）
        const [startH, startM] = (config.rangeStart || '00:00').split(':').map(Number);
        scheduledTask = cron.schedule(`${startM} ${startH} * * *`, () => { scheduleRandomExecution(config); }, { timezone: 'Asia/Shanghai' });
        scheduleRandomExecution(config);
        console.log(`[定时同步] 随机模式启动，范围 ${config.rangeStart || '00:00'}-${config.rangeEnd || '06:00'}`);
    } else {
        if (!cron.validate(config.cronTime)) { console.error(`[定时同步] cron 表达式无效: ${config.cronTime}`); return; }
        scheduledTask = cron.schedule(config.cronTime, () => { runScheduledSync().catch(err => console.error('[定时同步] 执行出错:', err.message)); }, { timezone: 'Asia/Shanghai' });
        console.log(`[定时同步] 固定模式启动，cron="${config.cronTime}", 模式="${config.syncMode}", 最多=${config.maxCount}条`);
    }
}

/**
 * 计算随机触发偏移：在 [max(窗口起点, 现在+1分钟), 窗口终点) 内随机取一分钟。
 * 窗口终点 <= 起点视为跨午夜（如 23:00-02:00）；旧实现只支持同日窗口，跨午夜配置永不触发。
 * 返回 { delayMinutes, atMinutes }，不在窗口内返回 null。
 */
function computeRandomDelay(config, nowMinutes, rand = Math.random) {
    const [startH, startM] = (config.rangeStart || '00:00').split(':').map(Number);
    const [endH, endM] = (config.rangeEnd || '06:00').split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const windowLen = ((endH * 60 + endM) - startMinutes + 1440) % 1440;
    const elapsed = (nowMinutes - startMinutes + 1440) % 1440; // 以窗口起点为 0 的相对分钟
    if (windowLen === 0 || elapsed + 1 >= windowLen) return null;
    const offset = elapsed + 1 + Math.floor(rand() * (windowLen - elapsed - 1));
    return { delayMinutes: offset - elapsed, atMinutes: (startMinutes + offset) % 1440 };
}

/**
 * 随机调度执行时间
 */
function scheduleRandomExecution(config) {
    if (randomTimer) { clearTimeout(randomTimer); randomTimer = null; }
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const plan = computeRandomDelay(config, nowMinutes);
    if (!plan) {
        console.log(`[定时同步] 当前北京时间 ${fmt(nowMinutes)} 不在执行窗口内，等待下次窗口（${config.rangeStart || '00:00'} 起）`);
        return;
    }
    console.log(`[定时同步] 随机触发安排在北京时间 ${fmt(plan.atMinutes)}（${plan.delayMinutes}分钟后）`);
    randomTimer = setTimeout(() => { runScheduledSync().catch(err => console.error('[定时同步] 随机执行出错:', err.message)); }, plan.delayMinutes * 60 * 1000);
}

module.exports = {
    runScheduledSync,
    computeRandomDelay,
    startScheduledTask,
    __setScheduledSyncRunnerForTest,
    __setRetryDelayForTest,
    executeScheduledSync,
};
