const axios = require('axios');
const { spawn } = require('child_process');

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

function fetchHtmlViaCurl(fetchUrl) {
  return new Promise((resolve, reject) => {
    // 安全校验：仅允许 http/https；用 '--' 隔离选项与 URL，
    // 防止以 '-' 开头的输入被 curl 当作参数（参数注入）
    if (!/^https?:\/\//i.test(fetchUrl)) {
      reject(new Error('非法的抓取地址，仅支持 http/https'));
      return;
    }

    const args = [
      '-s',
      '--max-time', '30',
      '-H', `User-Agent: ${UA_PC}`,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
      '--compressed',
      '--',
      fetchUrl
    ];

    const child = spawn('curl', args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf-8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf-8');
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`curl 退出码 ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
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
  let fetchUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
  try {
    const urlObj = new URL(realUrl);
    const xsec_token = urlObj.searchParams.get('xsec_token');
    const xsec_source = urlObj.searchParams.get('xsec_source');
    if (xsec_token) {
        fetchUrl += `?xsec_token=${encodeURIComponent(xsec_token)}&xsec_source=${encodeURIComponent(xsec_source || 'app_share')}`;
    }
  } catch (e) {}

  let html = '';
  try {
    html = await fetchHtmlViaCurl(fetchUrl);
  } catch (err) {
    throw new Error('使用 curl 抓取页面失败: ' + err.message);
  }

  // 小红书的数据通常存储在 window.__INITIAL_STATE__ 中
  // 注意：此处使用更加宽松的匹配，因为对象中可能包含 undefined 或换行
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
  if (!stateMatch) throw new Error('无法解析页面数据 (可能触发了反爬或匹配规则失效)');

  let stateStr = stateMatch[1];
  // 处理 JS 对象中的 undefined 关键字，JSON.parse 不支持它
  stateStr = stateStr.replace(/:\s*undefined/g, ':null');

  let state;
  try {
    state = JSON.parse(stateStr);
  } catch (err) {
    throw new Error('小红书数据反序列化失败，页面结构可能发生变化: ' + err.message);
  }

  if (!state || typeof state !== 'object') {
    throw new Error('页面解析数据非法，找不到有效的初始化状态');
  }

  const noteData = state.note?.noteDetailMap?.[noteId]?.note || state.note?.note || {};
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
    let vUrl = noteData.video?.media?.stream?.h264?.[0]?.masterUrl || '';
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
