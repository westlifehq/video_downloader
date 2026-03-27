const axios = require('axios');

/**
 * 小红书页面解析逻辑
 */

const UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function resolveXhsUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA_PC },
      maxRedirects: 10,
    });
    return res.request.res.responseUrl || url;
  } catch (err) {
    if (err.response && err.response.headers.location) {
        return err.response.headers.location;
    }
    return url;
  }
}

async function fetchXhsInfo(url) {
  const realUrl = await resolveXhsUrl(url);
  
  // 匹配笔记 ID
  const noteIdMatch = realUrl.match(/explore\/([a-zA-Z0-9]+)/) || 
                      realUrl.match(/discovery\/item\/([a-zA-Z0-9]+)/) ||
                      realUrl.match(/noteId=([a-zA-Z0-9]+)/);
  if (!noteIdMatch) throw new Error('解析失败，无法提取笔记 ID');
  const noteId = noteIdMatch[1];


  // 统一构建请求地址
  const fetchUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

  let html = '';
  try {
    const { execSync } = require('child_process');
    // 使用 curl 绕过 Node.js HTTP 客户端的 TLS/WAF 指纹拦截
    const curlCmd = `curl -s "${fetchUrl}" -H "User-Agent: ${UA_PC}" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7" -H "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8" --compressed`;
    html = execSync(curlCmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 });
  } catch (err) {
    if (!html) throw new Error('使用 curl 抓取页面失败: ' + err.message);
  }

  // 小红书的数据通常存储在 window.__INITIAL_STATE__ 中
  // 注意：此处使用更加宽松的匹配，因为对象中可能包含 undefined 或换行
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
  if (!stateMatch) throw new Error('无法解析页面数据 (可能触发了反爬或匹配规则失效)');

  let stateStr = stateMatch[1];
  // 处理 JS 对象中的 undefined 关键字，JSON.parse 不支持它
  stateStr = stateStr.replace(/:\s*undefined/g, ':null');

  const state = JSON.parse(stateStr);
  const noteData = state.note?.noteDetailMap?.[noteId]?.note || state.note?.note || {};

  
  if (!noteData.title && !noteData.desc) throw new Error('笔记内容为空或权限受限');

  const type = noteData.type === 'video' ? 'video' : 'image';
  const title = noteData.title || noteData.desc || '无标题';
  const author = noteData.user?.nickname || '未知作者';
  const cover = noteData.imageList?.[0]?.urlDefault || '';

  let videoUrl = '';
  let images = [];

  if (type === 'video') {
    // 提取视频地址，优先 masterUrl，并强制 https
    let vUrl = noteData.video?.media?.stream?.h264?.[0]?.masterUrl || '';
    if (vUrl && vUrl.startsWith('http://')) {
        vUrl = vUrl.replace('http://', 'https://');
    }
    videoUrl = vUrl;
  } else {
    // 提取所有图集地址 (顺便尝试移除水印参数)
    images = (noteData.imageList || []).map(img => {
        let u = img.urlDefault || img.url;
        if (u && u.startsWith('http://')) {
            u = u.replace('http://', 'https://');
        }
        // 小红书常见去水印：移除类似 ?imageView2/... 之后的部分
        return u.split('?')[0];
    });
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
