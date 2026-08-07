const express = require('express');
const router = express.Router();
const douyin = require('../lib/douyin');
const xhs = require('../lib/xhs');

// 允许解析的来源域名白名单（防止把服务端当代理请求任意内网/外网地址，即 SSRF）
// 注意：小红书分享短链同时存在 xhslink.com 与 xhslink.cn 两个域名（2026-08 起 .cn 新域名），缺一不可。
const ALLOWED_PARSE_SUFFIXES = [
    '.douyin.com',
    '.iesdouyin.com',
    '.snssdk.com',
    '.douyinvod.com',
    '.xhslink.com',
    '.xhslink.cn',
    '.xiaohongshu.com',
];
const ALLOWED_PARSE_EXACT = new Set([
    'douyin.com',
    'iesdouyin.com',
    'xhslink.com',
    'xhslink.cn',
    'xiaohongshu.com',
]);

function isAllowedParseHost(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (ALLOWED_PARSE_EXACT.has(hostname)) return true;
    return ALLOWED_PARSE_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

/**
 * POST /api/parse — 解析抖音/小红书链接
 */
router.post('/parse', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: '请提供视频/图集链接' });
    }

    if (!isAllowedParseHost(url)) {
        return res.status(400).json({ error: '仅支持解析抖音 / 小红书链接' });
    }

    try {
        console.log(`[解析] 输入链接: ${url}`);

        let info;
        if (url.includes('xhslink.com') || url.includes('xhslink.cn') || url.includes('xiaohongshu.com')) {
            console.log(`[解析] 检测到小红书链接`);
            info = await xhs.fetchXhsInfo(url);
        } else {
            console.log(`[解析] 检测到抖音链接`);
            const realUrl = await douyin.resolveShareUrl(url);
            console.log(`[解析] 真实链接: ${realUrl}`);

            // SSRF 纵深防御：重定向后的真实链接也必须命中白名单，
            // 防止短链被重定向到任意内网/外部地址后继续解析。
            if (!isAllowedParseHost(realUrl)) {
                throw new Error('链接重定向目标不受信任');
            }

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
        res.status(500).json({ error: '解析失败，请检查链接是否正确' });
    }
});

module.exports = router;
