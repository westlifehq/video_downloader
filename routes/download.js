const express = require('express');
const router = express.Router();
const path = require('path');
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const douyin = require('../lib/douyin');
const favorites = require('../lib/douyin-favorites');
const configHelper = require('../lib/config');
const taskManager = require('../lib/task-manager');
const fileHelper = require('../lib/file-helper');

/**
 * POST /api/download — 开始下载视频/图集
 */
router.post('/download', async (req, res) => {
    const { videoUrl, title, author, awemeId, type, images, livePhotos, cover, subDir } = req.body;
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

    if (awemeId !== undefined && awemeId !== null && awemeId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(String(awemeId))) {
        return res.status(400).json({ error: '作品 ID 格式无效' });
    }

    // Express 4 不捕获 async 异常：建目录/落库失败时若不兜底，请求会一直挂起
    let fileName, savePath, taskId;
    try {
        let downloadDir = await configHelper.getEffectiveDownloadDir();
        if (subDir) {
            const safeSubDir = douyin.sanitizeFilename(subDir);
            if (!safeSubDir || /^\.+$/.test(safeSubDir)) {
                return res.status(400).json({ error: '子目录无效' });
            }
            downloadDir = fileHelper.resolveWithinRoot(downloadDir, safeSubDir);
        }

        // 确保下载目录存在
        if (!fsSync.existsSync(downloadDir)) {
            const fs = require('fs').promises;
            await fs.mkdir(downloadDir, { recursive: true });
        }

        // 生成文件名或目录名
        fileName = douyin.buildDownloadName({ type, title, awemeId, livePhotos });
        savePath = fileHelper.resolveWithinRoot(downloadDir, fileName);

        taskId = uuidv4();
        await taskManager.createTask('download', taskId, {
            status: 'downloading',
            progress: 0,
            downloaded: 0,
            total: 0,
            filePath: savePath,
            fileName,
            title,
            author: typeof author === 'string' ? author.slice(0, 100) : '',
            // 封面与 awemeId 落库，供下载历史页渲染缩略图（旧记录无此字段，前端已有占位兜底）
            cover: typeof cover === 'string' ? cover : '',
            awemeId: awemeId || '',
            error: null
        });
    } catch (err) {
        console.error(`[下载] 任务创建失败: ${err.message}`);
        if (err.message === '非法下载路径') return res.status(400).json({ error: '非法下载路径' });
        return res.status(500).json({ error: '下载任务创建失败，请检查下载目录' });
    }

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
                fileSize: result.fileSize,
                completedAt: Date.now()
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
