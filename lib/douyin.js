const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 常用 User-Agent
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TRUSTED_DOWNLOAD_SUFFIXES = [
  '.douyinvod.com',
  '.douyinpic.com',
  '.douyincdn.com',
  '.bytecdn.cn',
  '.bytevcloudcdn.com',
  '.pstatp.com',
  '.snssdk.com',
  '.amemv.com',
  '.toutiaovod.com',
  '.xhscdn.com',
  '.xiaohongshu.com',
];
const TRUSTED_DOWNLOAD_EXACT = new Set([
  'www.douyin.com',
  'douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'ci.xiaohongshu.com',
]);


/**
 * 从分享文本中提取 URL
 */
function extractUrl(text) {
  // 匹配时即排除中文标点/引号（分享文案常紧跟标点且无空格），
  // 尾部再兜底剥离英文闭合标点，避免它们被当作 URL 的一部分导致请求失败。
  const urlMatch = text.match(/https?:\/\/[^\s，。！？；：、（）【】《》"'“”’‘]+/);
  if (!urlMatch) return null;
  return urlMatch[0].replace(/[,.!?;:)\]）】》]+$/, '');
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
 * 策略1: 抖音官方 Web API + 动态获取并维护合法的 ttwid（毫秒级、免登录）
 * 策略2: iesdouyin 分享页面抓取
 * 策略3: douyin.com PC 页面抓取
 * 策略4: Playwright 浏览器自动化拦截兜底
 */
async function fetchVideoInfo(videoId) {
  // 策略1: 官方 Web API（携带动态 ttwid）
  try {
    const info = await fetchFromWebApi(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略1-Web API] 失败: ${err.message}`);
  }

  // 策略2: iesdouyin 分享页面
  try {
    const info = await fetchFromSharePage(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略2-分享页面] 失败: ${err.message}`);
  }

  // 策略3: douyin.com PC 页面
  try {
    const info = await fetchFromDouyinPage(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略3-抖音页面] 失败: ${err.message}`);
  }

  // 策略4: Playwright 无头浏览器拦截兜底
  try {
    const info = await fetchViaPlaywright(videoId);
    if (info) return info;
  } catch (err) {
    console.log(`[策略4-浏览器兜底] 失败: ${err.message}`);
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

let cachedTtwid = null;
let ttwidExpireTime = 0;

/**
 * 动态获取并维护抖音合法的 ttwid 设备凭证
 */
async function getTtwid(forceRefresh = false) {
  if (!forceRefresh && cachedTtwid && Date.now() < ttwidExpireTime) {
    return cachedTtwid;
  }

  // 方式1: 字节跳动官方 ttwid 统一注册接口
  try {
    const resp = await axios.post('https://ttwid.bytedance.com/ttwid/union/register/', {
      region: 'cn',
      aid: 6383,
      needFid: false,
      service: 'www.ixigua.com',
      migrate_info: { ticket: '', edition: 'default' },
      cbUrlProtocol: 'https',
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    const cookies = resp.headers['set-cookie'];
    if (Array.isArray(cookies)) {
      for (const item of cookies) {
        const m = item.match(/ttwid=([^;]+)/);
        if (m) {
          cachedTtwid = m[1];
          ttwidExpireTime = Date.now() + 24 * 3600 * 1000;
          return cachedTtwid;
        }
      }
    }
  } catch (err) {
    // 降级方式2
  }

  // 方式2: 访问 douyin 视频页面提取响应头 Set-Cookie
  try {
    const resp = await axios.head('https://www.douyin.com/', {
      headers: { 'User-Agent': UA_PC },
      timeout: 5000,
      validateStatus: () => true,
    });
    const cookies = resp.headers['set-cookie'];
    if (Array.isArray(cookies)) {
      for (const item of cookies) {
        const m = item.match(/ttwid=([^;]+)/);
        if (m) {
          cachedTtwid = m[1];
          ttwidExpireTime = Date.now() + 24 * 3600 * 1000;
          return cachedTtwid;
        }
      }
    }
  } catch (err) {
    // 忽略
  }

  return cachedTtwid || '';
}

/**
 * 策略1: 抖音官方 Web API (基于 ttwid，毫秒级解析)
 */
async function fetchFromWebApi(videoId) {
  const apiUrl = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';

  const requestDetail = async (token) => {
    return await axios.get(apiUrl, {
      params: {
        device_platform: 'webapp',
        aid: 6383,
        channel: 'channel_pc_web',
        aweme_id: videoId,
        pc_client_type: 1,
        version_code: '190500',
        version_name: '19.5.0',
      },
      headers: {
        'User-Agent': UA_PC,
        'Referer': 'https://www.douyin.com/',
        'Cookie': token ? `ttwid=${token}` : '',
      },
      timeout: 10000,
    });
  };

  let ttwid = await getTtwid();
  let resp;
  try {
    resp = await requestDetail(ttwid);
  } catch (err) {
    ttwid = await getTtwid(true);
    resp = await requestDetail(ttwid);
  }

  if (resp?.data?.aweme_detail) {
    return normalizeVideoData(resp.data.aweme_detail);
  }

  if (ttwid) {
    ttwid = await getTtwid(true);
    try {
      resp = await requestDetail(ttwid);
      if (resp?.data?.aweme_detail) {
        return normalizeVideoData(resp.data.aweme_detail);
      }
    } catch (e) { }
  }

  return null;
}

/**
 * 策略4: Playwright 浏览器自动化拦截兜底
 */
async function fetchViaPlaywright(videoId) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    return null;
  }

  let browser = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      userAgent: UA_PC,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    let detailJson = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('aweme/v1/web/aweme/detail')) {
        try {
          const text = await response.text();
          const json = JSON.parse(text);
          if (json.aweme_detail) {
            detailJson = json.aweme_detail;
          }
        } catch (e) { }
      }
    });

    await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const waitStart = Date.now();
    while (!detailJson && Date.now() - waitStart < 5000) {
      await page.waitForTimeout(200);
    }

    if (detailJson) {
      return normalizeVideoData(detailJson);
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { }
    }
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

function isTrustedHost(hostname) {
  if (TRUSTED_DOWNLOAD_EXACT.has(hostname)) return true;
  const h = '.' + hostname;
  return TRUSTED_DOWNLOAD_SUFFIXES.some(suffix => h.endsWith(suffix));
}

function getSafeDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('下载地址无效');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅支持 http/https 下载地址');
  }

  if (!isTrustedHost(parsed.hostname)) {
    throw new Error(`下载地址主机不受信任: ${parsed.hostname}`);
  }

  return parsed;
}

/**
 * 下载视频到指定路径
 */
async function downloadVideo(videoUrl, savePath, onProgress, referer = 'https://www.douyin.com/') {
  const safeUrl = getSafeDownloadUrl(videoUrl);
  const dir = path.dirname(savePath);
  await fs.promises.mkdir(dir, { recursive: true });

  console.log(`[下载] 目标 URL: ${safeUrl.toString()}`);
  console.log(`[下载] 使用 Referer: ${referer}`);

  const resp = await axios.get(safeUrl.toString(), {
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
    const cleanup = () => {
      try { resp.data.destroy(); } catch (e) {}
      try { writer.close(); } catch (e) {}
      try { fs.unlinkSync(savePath); } catch (e) {}
    };
    writer.on('finish', () => resolve({
      filePath: savePath,
      fileSize: downloaded,
    }));
    writer.on('error', (err) => {
      cleanup();
      reject(err);
    });
    resp.data.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * 批量下载图片并保存到一个目录中
 */
async function downloadImages(images, dirPath, onProgress, referer = 'https://www.douyin.com/') {
  await fs.promises.mkdir(dirPath, { recursive: true });

  let totalDownloaded = 0;
  let failCount = 0;

  for (let i = 0; i < images.length; i++) {
    const savePath = path.join(dirPath, `${(i + 1).toString().padStart(2, '0')}.jpg`);

    try {
      // URL 白名单校验放到 try 内，单张非法 URL 不应中断整个图集
      const safeUrl = getSafeDownloadUrl(images[i]);

      const resp = await axios.get(safeUrl.toString(), {
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
      failCount++;
      console.error(`下载图片第 ${i + 1} 张失败: ${err.message}`);
      // 清理失败的半成品文件
      try { fs.unlinkSync(savePath); } catch (e) {}
    }

    if (onProgress) {
      // 无法提前得知总大小，所以用完成张数估算百分比
      const progress = Math.round(((i + 1) / images.length) * 100);
      onProgress(progress, totalDownloaded, 0); 
    }
  }

  if (failCount >= images.length) {
    throw new Error(`图集下载失败：全部 ${images.length} 张图片均未下载成功`);
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
  normalizeVideoData,
  downloadVideo,
  downloadImages,
  sanitizeFilename,
  getSafeDownloadUrl,
};
