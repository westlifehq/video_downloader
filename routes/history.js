const express = require('express');
const router = express.Router();
const taskManager = require('../lib/task-manager');
const fileHelper = require('../lib/file-helper');

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
    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: '未提供文件路径' });
    }

    try {
        await fileHelper.openFileInExplorer(filePath);
        res.json({ success: true });
    } catch (err) {
        console.error(`[打开文件] 失败: ${err.message}`);
        res.status(500).json({ error: err.message || '文件夹打开失败' });
    }
});

/**
 * POST /api/history/delete — 删除本地文件
 */
router.post('/history/delete', async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: '未提供文件路径' });
    }

    try {
        await fileHelper.safeDeleteFile(filePath);
        res.json({ success: true });
    } catch (err) {
        console.error(`[删除文件] 失败: ${err.message}`);
        res.status(500).json({ error: err.message || '删除失败' });
    }
});

module.exports = router;
