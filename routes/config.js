const express = require('express');
const router = express.Router();
const fsSync = require('fs');
const cron = require('node-cron');
const configHelper = require('../lib/config');
const schedulerService = require('../lib/scheduler-service');

/**
 * GET /api/config — 获取配置
 */
router.get('/config', async (req, res) => {
    const config = await configHelper.readConfig();
    const downloadDir = await configHelper.getEffectiveDownloadDir();
    res.json({
        ...config,
        downloadDir
    });
});

/**
 * POST /api/config — 保存配置
 */
router.post('/config', async (req, res) => {
    const { downloadDir } = req.body;
    if (!downloadDir) {
        return res.status(400).json({ error: '下载目录不能为空' });
    }

    // P0 修复：校验 downloadDir 合法性，禁止设置为系统根目录或敏感路径
    const path = require('path');
    const resolved = path.resolve(downloadDir);
    const dangerous = ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/root', '/sys', '/proc',
                       'C:\\', 'C:\\Windows', 'C:\\Windows\\System32'];
    if (dangerous.includes(resolved) || dangerous.includes(resolved.replace(/[\\/]+$/, ''))) {
        return res.status(400).json({ error: '禁止将下载目录设置为系统根目录或敏感路径' });
    }
    // 必须为绝对路径
    if (!path.isAbsolute(downloadDir)) {
        return res.status(400).json({ error: '下载目录必须为绝对路径' });
    }

    try {
        if (!fsSync.existsSync(downloadDir)) {
            const fs = require('fs').promises;
            await fs.mkdir(downloadDir, { recursive: true });
        }
        await configHelper.writeConfig({ downloadDir });
        res.json({ success: true, downloadDir });
    } catch (err) {
        res.status(500).json({ error: '目录创建失败' });
    }
});

/**
 * GET /api/schedule/config — 获取定时同步配置
 */
router.get('/schedule/config', async (req, res) => {
    const config = await configHelper.readScheduleConfig();
    res.json(config);
});

/**
 * POST /api/schedule/config — 保存定时同步配置
 */
router.post('/schedule/config', async (req, res) => {
    const { enabled, cronTime, syncMode, maxCount, triggerMode, rangeStart, rangeEnd } = req.body;
    const cfg = await configHelper.readScheduleConfig();
    if (typeof enabled === 'boolean') cfg.enabled = enabled;
    if (cronTime !== undefined) {
        if (!cron.validate(cronTime)) {
            return res.status(400).json({ error: `无效的 cron 表达式: ${cronTime}` });
        }
        cfg.cronTime = cronTime;
    }
    if (syncMode && ['favorites', 'liked', 'both', 'messages', 'all'].includes(syncMode)) cfg.syncMode = syncMode;
    if (maxCount && Number.isInteger(maxCount) && maxCount > 0 && maxCount <= 500) cfg.maxCount = maxCount;
    if (triggerMode && ['fixed', 'random'].includes(triggerMode)) cfg.triggerMode = triggerMode;
    const timeFormatRegex = /^\d{1,2}:\d{2}$/;
    if (rangeStart) {
        if (!timeFormatRegex.test(rangeStart)) return res.status(400).json({ error: 'rangeStart 格式应为 HH:MM' });
        cfg.rangeStart = rangeStart;
    }
    if (rangeEnd) {
        if (!timeFormatRegex.test(rangeEnd)) return res.status(400).json({ error: 'rangeEnd 格式应为 HH:MM' });
        cfg.rangeEnd = rangeEnd;
    }
    
    await configHelper.writeScheduleConfig(cfg);
    schedulerService.startScheduledTask();
    res.json({ success: true, config: cfg });
});

/**
 * GET /api/schedule/logs — 获取定时同步日志
 */
router.get('/schedule/logs', async (req, res) => {
    const logs = await configHelper.readScheduleLog();
    res.json(logs);
});

/**
 * POST /api/schedule/run — 手动触发定时同步
 */
router.post('/schedule/run', async (req, res) => {
    res.json({ success: true, message: '已触发定时同步' });
    schedulerService.runScheduledSync().catch(err => console.error('[定时同步] 手动触发执行出错:', err.message));
});

module.exports = router;
