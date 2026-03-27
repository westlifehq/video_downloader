const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 常用 User-Agent
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';


/**
 * 从分享文本中提取 URL
 */
function extractUrl(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : null;
}

/**
 * 解析抖音分享短链接，获取真实页面 URL
 */
async function resolveShareUrl(shareUrl) {
  const url = extractUrl(shareUrl);
  if (!url) {
    throw new Error('无法从输入中提取有效链接');
  }

  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA_MOBILE },
      maxRedirects: 5,
      validateStatus: () => true,
    });

    const finalUrl = resp.request?.res?.responseUrl || resp.headers?.location || url;
    return finalUrl;
  } catch (err) {
    if (err.response?.headers?.location) {
      return err.response.headers.location;
    }
    throw new Error(`解析链接失败: ${err.message}`);
  }
}

/**
 * 从 URL 中提取视频 ID
 */
function extractVideoId(url) {
  const patterns = [
    /\/video\/(\d+)/,
    /\/note\/(\d+)/,
    /\/share\/video\/(\d+)/,
    /modal_id=(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  throw new Error('无法从 URL 中提取视频 ID');
}

/**
 * 深度搜索对象中包含指定 key 的子对象
 */
function deepFind(obj, targetKey, maxDepth = 10) {
  if (!obj || typeof obj !== 'object' || maxDepth <= 0) return null;

  if (obj[targetKey] !== undefined) return obj;

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const result = deepFind(val, targetKey, maxDepth - 1);
      if (result) return result;
    }
  }
  return null;
}

/**
 * 获取视频信息 — 主入口
 * 通过 iesdouyin.com 分享页面抓取视频数据
 */
async function fetchVideoInfo(videoId) {
  // 策略1: iesdouyin 分享页面（短链接重定向后的目标）
  try {
    const info = await fetchFromSharePage(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略1-分享页面] 失败: ${err.message}`);
  }

  // 策略2: douyin.com 页面
  try {
    const info = await fetchFromDouyinPage(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略2-抖音页面] 失败: ${err.message}`);
  }

  // 策略3: 抖音 Web API
  try {
    const info = await fetchFromWebApi(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略3-Web API] 失败: ${err.message}`);
  }

  throw new Error('所有解析策略均失败，请稍后重试或检查链接是否有效');
}

/**
 * 策略1: 从 iesdouyin.com 分享页面提取
 */
async function fetchFromSharePage(videoId) {
  const pageUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;

  const resp = await axios.get(pageUrl, {
    headers: {
      'User-Agent': UA_MOBILE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 15000,
  });

  const html = resp.data;
  if (!html || html.length < 1000) {
    throw new Error('页面内容为空');
  }

  // 尝试从 _ROUTER_DATA 提取
  let videoData = extractFromRouterData(html);
  if (videoData) return videoData;

  // 尝试从 _SSR_DATA 提取
  videoData = extractFromSSRData(html);
  if (videoData) return videoData;

  // 尝试从 RENDER_DATA 提取
  videoData = extractFromRenderData(html);
  if (videoData) return videoData;

  // 最后尝试：直接从 HTML 中匹配视频 URL
  videoData = extractFromRawHtml(html, videoId);
  if (videoData) return videoData;

  throw new Error('无法从分享页面提取视频信息');
}

/**
 * 从 window._ROUTER_DATA 中提取视频信息
 */
function extractFromRouterData(html) {
  const marker = 'window._ROUTER_DATA = ';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const start = idx + marker.length;
  const end = html.indexOf('</script>', start);
  if (end === -1) return null;

  let jsonStr = html.substring(start, end).trim();
  if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);

  try {
    const data = JSON.parse(jsonStr);

    // 在 loaderData 中查找含有 play_addr 的数据
    if (data.loaderData) {
      for (const val of Object.values(data.loaderData)) {
        if (!val || typeof val !== 'object') continue;

        // 查找 item_list（iesdouyin 格式）
        const itemListHolder = deepFind(val, 'item_list');
        if (itemListHolder && Array.isArray(itemListHolder.item_list) && itemListHolder.item_list.length > 0) {
          const item = itemListHolder.item_list[0];
          if (item.video && item.video.play_addr) {
            return normalizeVideoData(item);
          }
        }

        // 查找 awemeDetail（douyin.com 格式）
        const detailHolder = deepFind(val, 'awemeDetail');
        if (detailHolder && detailHolder.awemeDetail) {
          return normalizeVideoData(detailHolder.awemeDetail);
        }

        // 查找 aweme_detail
        const detailHolder2 = deepFind(val, 'aweme_detail');
        if (detailHolder2 && detailHolder2.aweme_detail) {
          return normalizeVideoData(detailHolder2.aweme_detail);
        }

        // 直接查找含有 play_addr 的 video 对象
        const videoHolder = deepFind(val, 'play_addr');
        if (videoHolder) {
          // 往上找包含 desc 的父对象
          const parentWithDesc = deepFind(val, 'desc');
          if (parentWithDesc) {
            return normalizeVideoData(parentWithDesc);
          }
        }
      }
    }
  } catch (err) {
    console.log(`[_ROUTER_DATA] JSON 解析失败: ${err.message}`);
  }

  return null;
}

/**
 * 从 window._SSR_DATA 中提取
 */
function extractFromSSRData(html) {
  const marker = 'window._SSR_DATA = ';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const start = idx + marker.length;
  const end = html.indexOf('</script>', start);
  if (end === -1) return null;

  let jsonStr = html.substring(start, end).trim();
  if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);

  try {
    const data = JSON.parse(jsonStr);
    const itemHolder = deepFind(data, 'item_list');
    if (itemHolder && Array.isArray(itemHolder.item_list) && itemHolder.item_list[0]) {
      return normalizeVideoData(itemHolder.item_list[0]);
    }
    const detailHolder = deepFind(data, 'awemeDetail');
    if (detailHolder) {
      return normalizeVideoData(detailHolder.awemeDetail);
    }
  } catch (err) {
    console.log(`[_SSR_DATA] JSON 解析失败: ${err.message}`);
  }

  return null;
}

/**
 * 从 RENDER_DATA 中提取（douyin.com 格式）
 */
function extractFromRenderData(html) {
  const renderDataMatch = html.match(/<script id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);
  if (!renderDataMatch) return null;

  try {
    const decoded = decodeURIComponent(renderDataMatch[1]);
    const renderData = JSON.parse(decoded);

    for (const val of Object.values(renderData)) {
      if (!val || typeof val !== 'object') continue;
      const detailHolder = deepFind(val, 'awemeDetail');
      if (detailHolder && detailHolder.awemeDetail) {
        return normalizeVideoData(detailHolder.awemeDetail);
      }
      const detailHolder2 = deepFind(val, 'aweme_detail');
      if (detailHolder2 && detailHolder2.aweme_detail) {
        return normalizeVideoData(detailHolder2.aweme_detail);
      }
    }
  } catch (err) {
    console.log(`[RENDER_DATA] 解析失败: ${err.message}`);
  }

  return null;
}

/**
 * 最后手段：直接从 HTML 中正则匹配视频 URL
 */
function extractFromRawHtml(html, videoId) {
  // 匹配 play_addr 的 uri
  const uriMatch = html.match(/"play_addr"\s*:\s*\{[^}]*"uri"\s*:\s*"([^"]+)"/);
  if (uriMatch) {
    const uri = uriMatch[1];
    const videoUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=720p&line=0`;

    // 尝试提取标题
    const descMatch = html.match(/"desc"\s*:\s*"([^"]{1,200})"/);
    const authorMatch = html.match(/"nickname"\s*:\s*"([^"]{1,50})"/);

    return {
      videoUrl,
      title: descMatch ? unescapeUnicode(descMatch[1]) : '未知标题',
      author: authorMatch ? unescapeUnicode(authorMatch[1]) : '未知作者',
      authorId: '',
      cover: '',
      duration: 0,
      width: 0,
      height: 0,
      awemeId: videoId,
    };
  }

  return null;
}

/**
 * 策略2: 从 douyin.com 页面提取
 */
async function fetchFromDouyinPage(videoId) {
  const pageUrl = `https://www.douyin.com/video/${videoId}`;

  const resp = await axios.get(pageUrl, {
    headers: {
      'User-Agent': UA_PC,
      'Referer': 'https://www.douyin.com/',
      'Cookie': 'msToken=; ttwid=;',
    },
    timeout: 15000,
  });

  const html = resp.data;

  let result = extractFromRenderData(html);
  if (result) return result;

  result = extractFromRouterData(html);
  if (result) return result;

  result = extractFromRawHtml(html, videoId);
  if (result) return result;

  return null;
}

/**
 * 策略3: 抖音 Web API
 */
async function fetchFromWebApi(videoId) {
  const apiUrl = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';

  const resp = await axios.get(apiUrl, {
    params: {
      aweme_id: videoId,
      aid: 1128,
      version_name: '23.5.0',
      device_platform: 'android',
      os_version: '2333',
    },
    headers: {
      'User-Agent': UA_PC,
      'Referer': 'https://www.douyin.com/',
    },
    timeout: 15000,
  });

  if (resp.data?.aweme_detail) {
    return normalizeVideoData(resp.data.aweme_detail);
  }

  return null;
}

/**
 * 统一视频数据格式
 * 兼容 item_list 格式和 awemeDetail 格式
 */
function normalizeVideoData(item) {
  if (!item) throw new Error('数据为空');

  let type = 'video';
  let videoUrl = null;
  let images = [];
  let duration = 0;
  let width = 0;
  let height = 0;
  let cover = '';

  // 判断是否为图文
  if (item.images && item.images.length > 0) {
    type = 'image';
    images = item.images.map(img => {
      // 提取最高清原排版尺寸图片
      if (img.url_list && img.url_list.length > 0) {
        return unescapeUnicode(img.url_list[img.url_list.length - 1] || img.url_list[0]);
      }
      return null;
    }).filter(Boolean);
    
    // 图文封面一般就是第一张图
    if (images.length > 0) cover = images[0];
  } else {
    // 纯视频逻辑
    const video = item.video;
    if (!video) throw new Error('未找到视频或图文数据');

    duration = video.duration || 0;
    width = video.width || 0;
    height = video.height || 0;

    if (video.bit_rate && video.bit_rate.length > 0) {
      const sorted = [...video.bit_rate].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
      const best = sorted[0];
      if (best.play_addr?.url_list?.length > 0) {
        videoUrl = best.play_addr.url_list[0];
      }
    }
    if (!videoUrl && video.play_addr?.url_list?.length > 0) {
      videoUrl = video.play_addr.url_list[0];
    }
    if (!videoUrl && video.play_addr_h265?.url_list?.length > 0) {
      videoUrl = video.play_addr_h265.url_list[0];
    }
    if (!videoUrl && video.play_addr?.uri) {
      videoUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${video.play_addr.uri}&ratio=720p&line=0`;
    }
    if (!videoUrl) throw new Error('无法获取视频下载地址');

    videoUrl = unescapeUnicode(videoUrl);
    videoUrl = videoUrl.replace(/\/playwm\//g, '/play/').replace(/\/playwm\?/g, '/play?').replace(/watermark=1/g, 'watermark=0');

    const coverSources = [video.cover, video.origin_cover, video.dynamic_cover];
    for (const src of coverSources) {
      if (src?.url_list?.length > 0) {
        cover = src.url_list[0];
        break;
      }
    }
  }

  return {
    type,
    videoUrl,
    images,
    title: unescapeUnicode(item.desc || '未知标题'),
    author: unescapeUnicode(item.author?.nickname || '未知作者'),
    authorId: item.author?.unique_id || item.author?.short_id || '',
    cover,
    duration,
    width,
    height,
    awemeId: item.aweme_id || item.awemeId || '',
  };
}

/**
 * 反转义 \u002F 等 unicode 转义
 */
function unescapeUnicode(str) {
  if (!str) return str;
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

/**
 * 下载视频到指定路径
 */
async function downloadVideo(videoUrl, savePath, onProgress, referer = 'https://www.douyin.com/') {
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log(`[下载] 目标 URL: ${videoUrl}`);
  console.log(`[下载] 使用 Referer: ${referer}`);

  const resp = await axios.get(videoUrl, {
    headers: {
      'User-Agent': UA_PC,
      'Referer': referer,
      'Origin': referer.replace(/\/$/, ''), // 去掉结尾斜杠作为 Origin
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    },
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 10,
  }).catch(err => {
    if (err.response) {
        console.error(`[下载] 请求失败! 状态码: ${err.response.status}`);
        console.error(`[下载] 响应头: ${JSON.stringify(err.response.headers)}`);
    }
    throw err;
  });




  const totalLength = parseInt(resp.headers['content-length'], 10) || 0;
  let downloaded = 0;

  const writer = fs.createWriteStream(savePath);

  resp.data.on('data', (chunk) => {
    downloaded += chunk.length;
    if (onProgress && totalLength > 0) {
      const progress = Math.round((downloaded / totalLength) * 100);
      onProgress(progress, downloaded, totalLength);
    }
  });

  resp.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve({
      filePath: savePath,
      fileSize: downloaded,
    }));
    writer.on('error', reject);
    resp.data.on('error', reject);
  });
}

/**
 * 批量下载图片并保存到一个目录中
 */
async function downloadImages(images, dirPath, onProgress, referer = 'https://www.douyin.com/') {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let totalDownloaded = 0;
  
  for (let i = 0; i < images.length; i++) {
    const imgUrl = images[i];
    const savePath = path.join(dirPath, `${(i + 1).toString().padStart(2, '0')}.jpg`);
    
    try {
      const resp = await axios.get(imgUrl, {
        headers: {
          'User-Agent': UA_PC,
          'Referer': referer,
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        responseType: 'stream',
        timeout: 60000,
        maxRedirects: 10,
      });


      const writer = fs.createWriteStream(savePath);
      resp.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', () => {
          totalDownloaded += parseInt(resp.headers['content-length'] || 0, 10);
          resolve();
        });
        writer.on('error', reject);
        resp.data.on('error', reject);
      });
    } catch (err) {
      console.error(`下载图片 ${imgUrl} 失败: ${err.message}`);
    }

    if (onProgress) {
      // 无法提前得知总大小，所以用完成张数估算百分比
      const progress = Math.round(((i + 1) / images.length) * 100);
      onProgress(progress, totalDownloaded, 0); 
    }
  }

  return {
    filePath: dirPath,
    fileSize: totalDownloaded,
  };
}

/**
 * 生成安全的文件名
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .trim();
}

module.exports = {
  extractUrl,
  resolveShareUrl,
  extractVideoId,
  fetchVideoInfo,
  downloadVideo,
  downloadImages,
  sanitizeFilename,
};
