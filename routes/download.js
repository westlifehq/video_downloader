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
 * POST /api/download — 开始下载视频/图集
 */
router.post('/download', async (req, res) => {
    const { videoUrl, title, awemeId, type, images, livePhotos, subDir } = req.body;
    let { platform } = req.body;
    const isImage = type === 'image';

    // 自动补全 platform，防止前端缓存了旧版 app.js 没传 platform 参数。
    // 图集笔记 videoUrl 为空，必须同时检查 images 里的 CDN 域名，
    // 否则图集会用抖音 Referer 请求小红书 CDN 被 403 拒绝。
    if (!platform) {
        const urls = [videoUrl, ...(Array.isArray(images) ? images : [])].filter(Boolean);
        if (urls.some(u => u.includes('xhscdn.com') || u.includes('xiaohongshu.com'))) {
            platform = 'xhs';
        }
    }

    console.log(`[下载] 收到请求: ${title}, 平台: ${platform || '未知'}, 类型: ${type}, 子文件夹: ${subDir || '无'}`);

    let downloadDir = await configHelper.getEffectiveDownloadDir();
    if (subDir) {
        const safeSubDir = douyin.sanitizeFilename(subDir);
        downloadDir = path.join(downloadDir, safeSubDir);
    }

    // 确保下载目录存在
    if (!fsSync.existsSync(downloadDir)) {
        const fs = require('fs').promises;
        await fs.mkdir(downloadDir, { recursive: true });
    }

    // 生成文件名或目录名
    const safeName = douyin.sanitizeFilename(title || awemeId || 'douyin');
    const isLivePhoto = isImage && Array.isArray(livePhotos) && livePhotos.length > 0;
    const folderPrefix = isLivePhoto ? '[实况图]_' : '[图集]_';
    const fileName = isImage ? `${folderPrefix}${safeName}` : `${safeName}_${awemeId || Date.now()}.mp4`;
    const savePath = path.join(downloadDir, fileName);

    const taskId = uuidv4();
    await taskManager.createTask('download', taskId, {
        status: 'downloading',
        progress: 0,
        downloaded: 0,
        total: 0,
        filePath: savePath,
        fileName,
        title,
        error: null
    });

    res.json({ success: true, taskId });

    // 后台下载
    (async () => {
        try {
            const referer = platform === 'xhs' ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/';
            console.log(`[下载] 最终使用 Referer: ${referer}`);
            let result;

            if (isImage) {
                result = await douyin.downloadImages(images, savePath, async (progress, downloaded, total) => {
                    await taskManager.updateTask('download', taskId, { progress, downloaded, total });
                }, referer, livePhotos);
            } else {
                result = await douyin.downloadVideo(videoUrl, savePath, async (progress, downloaded, total) => {
                    await taskManager.updateTask('download', taskId, { progress, downloaded, total });
                }, referer);
            }

            await taskManager.updateTask('download', taskId, {
                status: 'done',
                progress: 100,
                fileSize: result.fileSize
            });

            // 记录已下载的 awemeId
            if (awemeId) {
                try { favorites.saveSyncedIds([awemeId]); } catch (e) { }
                try { favorites.saveLikedIds([awemeId]); } catch (e) { }
            }
            console.log(`[下载] 完成: ${savePath} (${(result.fileSize / 1024 / 1024).toFixed(2)} MB)`);
        } catch (err) {
            await taskManager.updateTask('download', taskId, {
                status: 'error',
                error: err.message
            });
            console.error(`[下载] 失败: ${err.message}`);
        }
    })();
});

/**
 * GET /api/download/:taskId — 查询下载进度
 */
router.get('/download/:taskId', (req, res) => {
    const task = taskManager.getTask('download', req.params.taskId);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }
    res.json(task);
});

module.exports = router;
