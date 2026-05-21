const express = require('express');
const router = express.Router();
const douyin = require('../lib/douyin');
const xhs = require('../lib/xhs');

/**
 * POST /api/parse — 解析抖音/小红书链接
 */
router.post('/parse', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: '请提供视频/图集链接' });
    }

    try {
        console.log(`[解析] 输入链接: ${url}`);

        let info;
        if (url.includes('xhslink.com') || url.includes('xiaohongshu.com')) {
            console.log(`[解析] 检测到小红书链接`);
            info = await xhs.fetchXhsInfo(url);
        } else {
            console.log(`[解析] 检测到抖音链接`);
            const realUrl = await douyin.resolveShareUrl(url);
            console.log(`[解析] 真实链接: ${realUrl}`);

            // 检查是否为用户主页链接
            if (realUrl.includes('/user/') || realUrl.includes('/share/user/')) {
                const secUidMatch = realUrl.match(/\/user\/([a-zA-Z0-9_\-\.]+)/);
                if (!secUidMatch) {
                    throw new Error('无法解析用户 ID (sec_uid)');
                }
                const secUid = secUidMatch[1];
                info = {
                    type: 'user',
                    secUid: secUid,
                    url: realUrl,
                    title: '抖音用户主页',
                    author: {
                        nickname: '抖音用户',
                        avatar: ''
                    }
                };
            } else {
                const videoId = douyin.extractVideoId(realUrl);
                console.log(`[解析] 视频 ID: ${videoId}`);
                info = await douyin.fetchVideoInfo(videoId);
            }
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

module.exports = router;
