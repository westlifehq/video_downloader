const express = require('express');
const router = express.Router();
const taskManager = require('../lib/task-manager');
const fileHelper = require('../lib/file-helper');
const favorites = require('../lib/douyin-favorites');
const path = require('path');

/**
 * GET /api/history — 获取下载历史（已完成的任务）
 */
router.get('/history', (req, res) => {
    const tasks = taskManager.getAllTasks('download');
    const history = tasks.filter(t => t.status === 'done');
    // 按时间倒序
    history.sort((a, b) => b.startTime - a.startTime);
    res.json(history);
});

/**
 * POST /api/history/open — 打开本地文件
 */
router.post('/history/open', async (req, res) => {
    if (req.app.locals.remoteManagementDisabled) {
        return res.status(403).json({ error: '当前部署模式已禁用远程文件管理能力' });
    }

    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: '未提供文件路径' });
    }

    try {
        await fileHelper.openFileInExplorer(filePath);
        res.json({ success: true });
    } catch (err) {
        console.error(`[打开文件] 失败: ${err.message}`);
        res.status(500).json({ error: '文件夹打开失败' });
    }
});

/**
 * POST /api/history/delete — 删除本地文件
 */
router.post('/history/delete', async (req, res) => {
    if (req.app.locals.remoteManagementDisabled) {
        return res.status(403).json({ error: '当前部署模式已禁用远程删除能力' });
    }

    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: '未提供文件路径' });
    }

    try {
        await fileHelper.safeDeleteFile(filePath);

        // 删除后让下载状态真正对齐：移除指向该文件的历史记录与"已下载"ID，后续同步可重新下载。
        // awemeId 优先取历史记录，其次从落盘名末尾的 _<作品ID> 解析（同步列表直接删的文件可能没有历史记录）
        const target = path.resolve(filePath);
        const ids = new Set();
        for (const task of taskManager.getAllTasks('download')) {
            if (task.filePath && path.resolve(task.filePath) === target) {
                if (task.awemeId) ids.add(task.awemeId);
                await taskManager.deleteTask('download', task.id);
            }
        }
        const m = path.basename(target).match(/_(\d{15,20})(?:\.mp4)?$/);
        if (m) ids.add(m[1]);
        await favorites.removeDownloadedIds([...ids]);

        res.json({ success: true });
    } catch (err) {
        console.error(`[删除文件] 失败: ${err.message}`);
        res.status(500).json({ error: '删除失败' });
    }
});

module.exports = router;
