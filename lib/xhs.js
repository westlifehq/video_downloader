const axios = require('axios');

/**
 * 小红书页面解析逻辑
 *
 * 2026-09 反爬升级后的两个关键事实：
 * 1. 小红书边缘节点会识别 curl（LibreSSL）的 TLS 指纹，对 explore/discovery
 *    页面一律 302 跳登录页，即使请求头与浏览器完全一致；Node 的 TLS 栈不受影响。
 *    因此页面抓取必须走 axios，不能再 spawn curl。
 * 2. 短链（xhslink.com/.cn）302 落地后的 discovery/item 页面本身就是 SSR 渲染的
 *    笔记页，响应体自带完整的 window.__INITIAL_STATE__，直接复用即可，
 *    无需再对 explore/{noteId} 发起第二次请求（第二次请求反而更容易触发风控）。
 */

const UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA_PC,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/**
 * 请求页面并跟随重定向，返回 { finalUrl, html, status }
 */
async function fetchPage(url) {
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    maxRedirects: 10,
    timeout: 30000,
    validateStatus: () => true,
  });
  return {
    finalUrl: res.request?.res?.responseUrl || url,
    html: typeof res.data === 'string' ? res.data : '',
    status: res.status,
  };
}

/**
 * 解析分享短链 / 直接链接，返回 { realUrl, html }
 * 短链重定向的最终响应体如果是笔记页则直接复用，避免二次请求
 */
async function resolveXhsUrl(url) {
  const { finalUrl, html } = await fetchPage(url);
  return { realUrl: finalUrl, html };
}

/**
 * 从 HTML 中提取并反序列化 window.__INITIAL_STATE__
 */
function parseInitialState(html) {
  // 小红书的数据通常存储在 window.__INITIAL_STATE__ 中
  // 注意：此处使用更加宽松的匹配，因为对象中可能包含 undefined 或换行
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
  if (!stateMatch) return null;

  let stateStr = stateMatch[1];
  // 处理 JS 对象中的 undefined 关键字，JSON.parse 不支持它
  stateStr = stateStr.replace(/:\s*undefined/g, ':null');

  try {
    return JSON.parse(stateStr);
  } catch {
    return null;
  }
}

/**
 * 从 __INITIAL_STATE__ 中提取笔记数据
 */
function extractNoteData(state, noteId) {
  const noteMap = state?.note?.noteDetailMap || {};
  return noteMap[noteId]?.note
    // 兜底：部分页面没有 noteDetailMap，用 currentNoteId 或第一个 entry
    || noteMap[state?.note?.currentNoteId]?.note
    || Object.values(noteMap)[0]?.note
    || state?.note?.note
    || null;
}

async function fetchXhsInfo(url) {
  // 第一步：解析短链 / 直接请求页面
  // 对短链，重定向落地页本身就是笔记页；对直接链接，响应体即笔记页
  let realUrl, html;
  try {
    ({ realUrl, html } = await resolveXhsUrl(url));
  } catch (err) {
    throw new Error('请求小红书页面失败: ' + err.message);
  }

  // 匹配笔记 ID（短链重定向后可能落在 discovery/item，浏览器复制的链接通常是 explore）
  const noteIdMatch = realUrl.match(/explore\/([a-zA-Z0-9]+)/) ||
                      realUrl.match(/discovery\/item\/([a-zA-Z0-9]+)/) ||
                      realUrl.match(/noteId=([a-zA-Z0-9]+)/) ||
                      html.match(/"noteId":"([a-zA-Z0-9]+)"/);
  if (!noteIdMatch) throw new Error('解析失败，无法提取笔记 ID');
  const noteId = noteIdMatch[1];

  // 第二步：解析页面内嵌数据；短链落地页通常已含数据，直接复用
  let state = parseInitialState(html);
  let noteData = state ? extractNoteData(state, noteId) : null;

  // 第三步：兜底——落地页没有笔记数据（如部分直接链接被风控）时，
  // 携带原链接的 xsec_token 重试标准 explore 页面
  if (!noteData || (!noteData.title && !noteData.desc)) {
    let fetchUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    try {
      const urlObj = new URL(realUrl);
      const xsec_token = urlObj.searchParams.get('xsec_token');
      const xsec_source = urlObj.searchParams.get('xsec_source');
      if (xsec_token) {
        fetchUrl += `?xsec_token=${encodeURIComponent(xsec_token)}&xsec_source=${encodeURIComponent(xsec_source || 'app_share')}`;
      }
    } catch (e) { /* realUrl 非法时直接用裸 explore 地址重试 */ }

    let retryHtml = '';
    try {
      retryHtml = (await fetchPage(fetchUrl)).html;
    } catch (err) {
      throw new Error('抓取小红书页面失败: ' + err.message);
    }

    state = parseInitialState(retryHtml);
    noteData = state ? extractNoteData(state, noteId) : null;
  }

  if (!state) throw new Error('无法解析页面数据 (可能触发了反爬或匹配规则失效)');
  if (!noteData || typeof noteData !== 'object' || (!noteData.title && !noteData.desc)) {
    throw new Error('笔记内容为空、权限受限或数据结构已被更改');
  }

  const type = noteData.type === 'video' ? 'video' : 'image';
  const title = noteData.title || noteData.desc || '无标题';
  const author = noteData.user?.nickname || '未知作者';
  // 封面与 images/videoUrl 保持一致，强制 https，避免 https 部署下混合内容被拦截
  let cover = noteData.imageList?.[0]?.urlDefault || '';
  if (cover && cover.startsWith('http://')) {
    cover = cover.replace('http://', 'https://');
  }

  let videoUrl = '';
  let images = [];

  if (type === 'video') {
    // 提取视频地址，优先 masterUrl，并强制 https
    const stream = noteData.video?.media?.stream || {};
    const candidates = [
      stream.h264?.[0],
      stream.h265?.[0],
      stream.av1?.[0],
      stream.h266?.[0],
    ].filter(Boolean);
    // 优先 defaultStream 标记的清晰度，否则取第一个可用流
    const picked = candidates.find(c => c.defaultStream) || candidates[0];
    let vUrl = picked?.masterUrl || '';
    if (vUrl && vUrl.startsWith('http://')) {
      vUrl = vUrl.replace('http://', 'https://');
    }
    videoUrl = vUrl;
  } else {
    // 提取所有图集地址 (顺便尝试移除水印参数)
    images = (noteData.imageList || []).map(img => {
      if (!img) return null;
      let u = img.urlDefault || img.url;
      if (u && u.startsWith('http://')) {
        u = u.replace('http://', 'https://');
      }
      // 小红书常见去水印：移除类似 ?imageView2/... 之后的部分
      return u ? u.split('?')[0] : null;
    }).filter(Boolean);
  }


  return {
    type,
    videoUrl,
    images,
    title,
    author,
    cover,
    awemeId: noteId, // 复用 id 字段名以适配前端
    platform: 'xhs'
  };
}

module.exports = {
  fetchXhsInfo
};
