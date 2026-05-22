/**
 * 抖音收藏同步模块
 * 
 * 使用 Playwright 浏览器自动化 + API 响应拦截方案。
 * 不需要逆向 X-Bogus 签名，让浏览器自己计算签名，我们只拦截响应数据。
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Playwright 延迟加载
let chromium = null;
function getChromium() {
  if (!chromium) {
    try {
      const { chromium: chromiumExtra } = require('playwright-extra');
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromiumExtra.use(stealth);
      chromium = chromiumExtra;
      console.log('[收藏同步] 已启用 Stealth 隐身模式');
    } catch (err) {
      console.error('[收藏同步] 加载 Stealth 插件失败:', err.message);
      try {
        chromium = require('playwright').chromium;
      } catch (err2) {
        throw new Error('Playwright 未安装。请运行: npm install playwright && npx playwright install chromium');
      }
    }
  }
  return chromium;
}

// 路径配置
const isPkg = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? path.dirname(process.execPath) : process.cwd();
const USER_DATA_DIR = path.join(BASE_DIR, 'user_data');
const SYNCED_IDS_PATH = path.join(BASE_DIR, 'synced_ids.json');
const COOKIE_PATH = path.join(BASE_DIR, 'douyin_session.json');
const LIKED_IDS_PATH = path.join(BASE_DIR, 'liked_ids.json');

// 全局浏览器引用（防止重复启动）
let activeBrowser = null;
let loginResolve = null;
let currentQrCode = null; // 存储 Base64 格式的登录二维码

/**
 * 检查登录状态
 */
async function checkLoginStatus() {
  // 只有存在手动注入的 cookie 文件才算"已登录"
  const hasCookie = await fileExists(COOKIE_PATH);
  let sessionId = null;
  if (hasCookie) {
    try {
      const data = JSON.parse(await fs.readFile(COOKIE_PATH, 'utf8'));
      sessionId = data.sessionid;
    } catch(e) {}
  }

  const syncData = await getSyncedData();

  return {
    loggedIn: hasCookie && !!sessionId,
    lastSyncTime: syncData.lastSyncTime || null,
    syncedCount: syncData.ids ? syncData.ids.length : 0,
  };
}

/**
 * 打开浏览器窗口让用户扫码登录
 */
async function openLoginBrowser() {
  if (activeBrowser) {
    try {
      console.log('[收藏同步] 发现已有浏览器实例，正在尝试关闭...');
      await activeBrowser.close();
    } catch (e) {
      console.error('[收藏同步] 关闭已有浏览器失败:', e.message);
    }
    activeBrowser = null;
  }

  currentQrCode = null; // 启动前务必清空二维码缓存
  const pw = getChromium();

  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  let context;
  const isDocker = fsSync.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
  const headless = isDocker || process.env.HEADLESS === 'true';
  console.log(`[收藏同步] 浏览器启动模式: ${headless ? '无头' : '有头'}`);

  const launchOptions = {
    headless: headless,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'zh-CN',
  };

  try {
    context = await pw.launchPersistentContext(USER_DATA_DIR, launchOptions);
    activeBrowser = context;
  } catch (err) {
    console.error('[收藏同步] 浏览器启动失败:', err.message);
    throw new Error(`启动失败: ${err.message}。请确保已安装 Playwright 环境。`);
  }

  const page = await context.newPage();
  currentQrCode = null; // 重置二维码数据

  // 截图获取二维码逻辑
  const captureQr = async () => {
    try {
      const selectors = ['.douyin-login-qr-code-img', 'img[src*="qrcode"]', '.douyin-login__qr-code'];
      for (const sel of selectors) {
        const qrEl = await page.$(sel);
        if (qrEl) {
          const base64 = await qrEl.screenshot({ type: 'png', encoding: 'base64' });
          currentQrCode = `data:image/png;base64,${base64}`;
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error('[收藏同步] 截图失败:', e.message);
      return false;
    }
  };

  const screenshotPath = path.join(BASE_DIR, 'login_debug.png');
  const saveDebugShot = async (name = '') => {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[收藏同步] 诊断截图已保存 (${name})`);
    } catch (e) { }
  };

  await saveDebugShot('开始加载');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  console.log('[收藏同步] 正在等待二维码生成...');
  let qrFound = false;
  for (let i = 0; i < 15; i++) {
    qrFound = await captureQr();
    if (qrFound) {
      console.log('[收藏同步] 已成功获取登录二维码 Base64');
      await saveDebugShot('二维码已出现');
      break;
    }
    
    if (i === 6) {
      console.log('[收藏同步] 尝试通过点击页面按钮唤起登录弹窗...');
      await saveDebugShot('尝试点击登录前');
      try {
        const loginBtnSelectors = ['.dy-header-login-button', 'button:has-text("登录")', '[data-e2e="dy-header-login-btn"]', '.login-button-content'];
        for (const sel of loginBtnSelectors) {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            console.log(`[收藏同步] 已点击登录按钮: ${sel}`);
            await page.waitForTimeout(1000);
            await saveDebugShot('点击登录后');
            break;
          }
        }
      } catch (e) { }
    }
    await page.waitForTimeout(1000);
  }

  if (!qrFound) await saveDebugShot('最终未发现二维码');

  console.log('[收藏同步] 请在浏览器界面或显示的二维码中扫码登录...');

  return new Promise((resolve, reject) => {
    let checkInterval;
    let timeoutTimer;
    loginResolve = resolve;
    
    checkInterval = setInterval(async () => {
      try {
        const isLoggedIn = await page.evaluate(() => {
          const isAvatarExist = !!document.querySelector('[data-e2e="user-avatar"]');
          const isHomeTabExist = !!document.querySelector('[data-e2e="user-tab-favorite"]');
          const hasLoginCookie = document.cookie.includes('sessionid') && /sessionid=[a-zA-Z0-9]{32,}/.test(document.cookie);
          return (isAvatarExist && isHomeTabExist) || !!hasLoginCookie;
        });

        if (isLoggedIn) {
          console.log('[收藏同步] 登录成功！');
          clearInterval(checkInterval);
          clearTimeout(timeoutTimer);

          // 提取并在本地持久化 sessionid
          try {
            const cookies = await context.cookies();
            const sessionCookie = cookies.find(c => c.name === 'sessionid');
            let sessionId = sessionCookie ? sessionCookie.value : null;

            if (!sessionId) {
              const pageCookies = await page.evaluate(() => document.cookie);
              const match = pageCookies.match(/sessionid=([a-zA-Z0-9]+)/) || pageCookies.match(/sessionid=([^;]+)/);
              if (match) sessionId = match[1].trim();
            }

            if (sessionId) {
              await fs.mkdir(USER_DATA_DIR, { recursive: true });
              await fs.writeFile(COOKIE_PATH, JSON.stringify({
                sessionid: sessionId,
                updatedAt: new Date().toISOString()
              }, null, 2));
              console.log('[收藏同步] 扫码登录成功，已自动持久化 sessionid 至 douyin_session.json');
            } else {
              console.warn('[收藏同步] 登录检测成功，但未能在浏览器上下文中提取到 sessionid');
            }
          } catch (e) {
            console.error('[收藏同步] 保存扫码登录 cookie 失败:', e.message);
          }

          await page.waitForTimeout(500);
          await context.close();
          activeBrowser = null;
          loginResolve = null;
          resolve({ success: true });
        }
      } catch (err) {
        if (err.message.includes('closed') || err.message.includes('Target')) {
          clearInterval(checkInterval);
          clearTimeout(timeoutTimer);
          activeBrowser = null;
          loginResolve = null;
          const status = await checkLoginStatus();
          if (status.loggedIn) resolve({ success: true });
          else reject(new Error('浏览器已关闭，登录未完成'));
        }
      }
    }, 2000);

    timeoutTimer = setTimeout(async () => {
      clearInterval(checkInterval);
      try { await context.close(); } catch (e) { }
      activeBrowser = null;
      loginResolve = null;
      reject(new Error('登录超时（5分钟），请重试'));
    }, 5 * 60 * 1000);

    context.on('close', () => {
      clearInterval(checkInterval);
      clearTimeout(timeoutTimer);
      activeBrowser = null;
      loginResolve = null;
    });
  });
}

/**
 * 获取收藏列表
 */
async function fetchFavorites(maxCount = 50, onProgress = null, checkInterrupt = null, tabType = 'favorite') {
  if (activeBrowser) {
    throw new Error('已有一个浏览器窗口在运行，请先完成当前操作');
  }

  if (!(await checkLoginStatus()).loggedIn) {
    throw new Error('未登录，请先扫码登录');
  }

  const tabLabel = tabType === 'like' ? '喜欢同步' : '收藏同步';
  const pw = getChromium();
  const isDocker = fsSync.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
  const headless = isDocker || process.env.HEADLESS === 'true';
  console.log(`[${tabLabel}] 启动浏览器同步页面，目标获取 ${maxCount} 条...`);

  const launchOptions = {
    headless: headless,
    viewport: { width: 1280, height: 1280 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
      '--ignore-certificate-errors',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'zh-CN',
  };

  let context;
  try {
    context = await pw.launchPersistentContext(USER_DATA_DIR, launchOptions);
    activeBrowser = context;

    // 从本地文件读取 cookie 并注入到浏览器上下文
    if (await fileExists(COOKIE_PATH)) {
      try {
        const cookieData = JSON.parse(await fs.readFile(COOKIE_PATH, 'utf8'));
        const sid = cookieData.sessionid;
        if (sid) {
          const cookieNames = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'];
          await context.addCookies(cookieNames.map(name => ({
            name, value: sid, domain: '.douyin.com', path: '/'
          })));
          console.log(`[${tabLabel}] 已从本地文件注入 ${cookieNames.length} 个 cookie`);
        }
      } catch (e) {
        console.error(`[${tabLabel}] 读取本地 cookie 文件失败:`, e.message);
      }
    }
  } catch (err) {
    console.error(`[${tabLabel}] fetchFavorites 启动浏览器失败:`, err.message);
    throw new Error(`启动失败: ${err.message}`);
  }

  try {
    const page = await context.newPage();

    page.on('dialog', async dialog => {
      console.log(`[${tabLabel}] 自动关闭弹窗: ${dialog.message()}`);
      try { await dialog.dismiss(); } catch(e){}
    });

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const collected = [];
    const seenIds = new Set();
    let hasMore = true;
    let apiHitCount = 0;

    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      const isFavApi = url.includes('favorite') || url.includes('collection') || url.includes('/like');
      if (!isFavApi) return;

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json') && !contentType.includes('text')) return;

      try {
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { return; }

        let awemeList = json.aweme_list || [];
        if (awemeList.length === 0 && json.data && json.data.aweme_list) awemeList = json.data.aweme_list;
        if (awemeList.length === 0 && json.collects_list) awemeList = json.collects_list;
        if (awemeList.length === 0 && json.data && json.data.collects_list) awemeList = json.data.collects_list;

        if (awemeList.length === 0) return;

        apiHitCount++;
        console.log(`[${tabLabel}] ✅ 拦截到 API 响应 #${apiHitCount}，包含 ${awemeList.length} 条视频`);

        for (const item of awemeList) {
          if (collected.length >= maxCount) break;
          const awemeId = item.aweme_id || '';
          if (seenIds.has(awemeId)) continue;
          seenIds.add(awemeId);
          collected.push(item);
          if (onProgress) onProgress(collected.length, maxCount, { awemeId, title: item.desc || '未知标题' });
        }
        if (json.has_more === false || json.has_more === 0) hasMore = false;
      } catch (err) { }
    });

    console.log(`[${tabLabel}] 打开个人主页...`);
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForSelector('.dy-header-login-button, [data-e2e="user-tab-favorite"], [data-e2e="user-tab-like"], .avatar-container', { timeout: 8000 });
    } catch (e) {}

    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('passport')) throw new Error('登录态已失效，请重新扫码登录');

    let clickedTab = false;
    let tabSelectors, tabTexts, fallbackUrl;

    if (tabType === 'like') {
      tabSelectors = ['[data-e2e="user-tab-like"]'];
      tabTexts = ['喜欢'];
      fallbackUrl = 'https://www.douyin.com/user/self?showTab=like';
    } else {
      tabSelectors = ['[data-e2e="user-tab-favorite"]', '[data-e2e="user-tab-collection"]'];
      tabTexts = ['收藏'];
      fallbackUrl = 'https://www.douyin.com/user/self?showTab=favorite';
    }

    for (const sel of tabSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        clickedTab = true;
        console.log(`[${tabLabel}] 通过选择器 ${sel} 点击了 tab`);
        break;
      }
    }

    if (!clickedTab) {
      for (const text of tabTexts) {
        try {
          const tabEl = await page.locator(`span:has-text("${text}")`).first();
          if (await tabEl.isVisible()) {
            await tabEl.click();
            clickedTab = true;
            console.log(`[${tabLabel}] 通过文字 "${text}" 点击了 tab`);
            break;
          }
        } catch (e) { }
      }
    }

    if (!clickedTab) {
      console.log(`[${tabLabel}] ⚠️ 未能点击 tab，尝试直接导航`);
      try {
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch (err) {
        console.log(`[${tabLabel}] 导航可能超时，忽略继续: ${err.message}`);
      }
    }

    const startWait = Date.now();
    while (collected.length === 0 && Date.now() - startWait < 4000) {
      await page.waitForTimeout(100);
    }
    // 保存一张截图以诊断无头模式为何找不到视频
    try {
      await page.screenshot({ path: path.join(__dirname, '../public/fav_debug.png'), fullPage: false });
      console.log(`[${tabLabel}] 已保存诊断截图 fav_debug.png`);
    } catch(e) {}
    
    console.log(`[${tabLabel}] 已收集 ${collected.length} 条，开始滚动...`);

    let scrollAttempts = 0;
    const maxScrollAttempts = 30;
    let lastCollectedCount = 0;
    let staleScrolls = 0;

    while (collected.length < maxCount && hasMore && scrollAttempts < maxScrollAttempts) {
      if (checkInterrupt && checkInterrupt()) break;
      scrollAttempts++;
      try {
        // 使用 timeout 包装，防止在此处无限卡死
        await Promise.race([
          page.evaluate(() => window.scrollBy(0, 800)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3000))
        ]);
      } catch(e) {
        console.log(`[${tabLabel}] 滚动报错/超时: ${e.message}`);
        break;
      }
      const currentCount = collected.length;
      const scrollWaitStart = Date.now();
      const maxScrollWait = 2000 + Math.random() * 1500;
      while (collected.length === currentCount && Date.now() - scrollWaitStart < maxScrollWait) {
        await page.waitForTimeout(100);
      }
      if (collected.length === lastCollectedCount) {
        staleScrolls++;
        if (staleScrolls >= 6) break;
      } else {
        staleScrolls = 0;
        lastCollectedCount = collected.length;
      }
    }

    if (collected.length === 0) {
      const pageTitle = await page.title();
      console.log(`[${tabLabel}] 收集完为0。当前页面标题: ${pageTitle}`);
      try {
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
        console.log(`[${tabLabel}] 页面前500字符: ${bodyText.replace(/\n/g, ' ')}`);
      } catch(e) {}
    }

    console.log(`[${tabLabel}] 收集完成，共 ${collected.length} 条视频`);
    return collected;
  } finally {
    activeBrowser = null;
    try { await context.close(); } catch (e) { }
  }
}

/**
 * 退出登录
 */
async function logout() {
  if (activeBrowser) {
    try {
      const contexts = activeBrowser.contexts();
      for (const ctx of contexts) {
        await ctx.clearCookies();
        await ctx.close();
      }
      await activeBrowser.close();
    } catch (e) { }
    activeBrowser = null;
  }

  if (await fileExists(USER_DATA_DIR)) {
    try {
      await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error('[退出登录] 清理 user_data 目录失败:', err.message);
    }
  }
  // 删掉持久化的 cookie 文件
  if (await fileExists(COOKIE_PATH)) {
    try { await fs.unlink(COOKIE_PATH); } catch(e) {}
  }
  return { success: true };
}

// 简易文件锁，防止竞态条件下的 read-modify-write 数据丢失
const _fileLocks = new Map();
async function withFileLock(filePath, fn) {
  while (_fileLocks.get(filePath)) {
    await new Promise(r => setTimeout(r, 50));
  }
  _fileLocks.set(filePath, true);
  try {
    return await fn();
  } finally {
    _fileLocks.delete(filePath);
  }
}

async function getSyncedData() {
  try { return JSON.parse(await fs.readFile(SYNCED_IDS_PATH, 'utf-8')); } catch { return { lastSyncTime: null, ids: [] }; }
}

async function saveSyncedIds(newIds) {
  return withFileLock(SYNCED_IDS_PATH, async () => {
    const data = await getSyncedData();
    const existingSet = new Set(data.ids || []);
    for (const id of newIds) existingSet.add(id);
    const updated = { lastSyncTime: new Date().toISOString(), ids: Array.from(existingSet) };
    await fs.writeFile(SYNCED_IDS_PATH, JSON.stringify(updated, null, 2));
    return updated;
  });
}

/**
 * 手动注入 Cookie 登录
 * 只需将 sessionid 持久化到本地文件，无需启动浏览器。
 * 浏览器会在 fetchFavorites 时再启动并从文件中读取 cookie 注入。
 */
async function loginWithCookie(cookieString) {
  if (activeBrowser) {
    try { await logout(); } catch (e) { }
  }

  // 简单验证与清理
  const cleanCookie = cookieString.trim();
  if (!cleanCookie) throw new Error('Cookie 不能为空');

  // 提取 sessionid 值
  let sessionValue = cleanCookie;
  if (cleanCookie.includes('sessionid=')) {
    const match = cleanCookie.match(/sessionid=([a-zA-Z0-9]+)/);
    if (match) {
        sessionValue = match[1].trim();
    } else {
        const matchFallback = cleanCookie.match(/sessionid=([^;]+)/);
        if (matchFallback) {
            sessionValue = matchFallback[1].trim();
        }
    }
  } else {
    sessionValue = sessionValue.trim();
  }

  // 基本格式校验：sessionid 应为 32 位以上的字母数字串
  if (!/^[a-zA-Z0-9]{16,}$/.test(sessionValue)) {
    throw new Error('sessionid 格式不正确，应为一串字母数字（通常 32 位以上）');
  }

  // 确保 user_data 目录存在
  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  // 持久化到本地文件，供 fetchFavorites 使用
  await fs.writeFile(COOKIE_PATH, JSON.stringify({ sessionid: sessionValue, updatedAt: new Date().toISOString() }, null, 2));

  console.log(`[收藏同步] Cookie 注入成功，已持久化到文件 (sessionid=${sessionValue.substring(0, 8)}...)`);
  return { success: true };
}

/**
 * 获取喜欢的视频列表（复用 fetchFavorites 内部逻辑，切换到"喜欢"tab）
 */
async function fetchLikedVideos(maxCount = 50, onProgress = null, checkInterrupt = null) {
  return fetchFavorites(maxCount, onProgress, checkInterrupt, 'like');
}

async function getLikedData() {
  try { return JSON.parse(await fs.readFile(LIKED_IDS_PATH, 'utf-8')); } catch { return { lastSyncTime: null, ids: [] }; }
}

async function saveLikedIds(newIds) {
  return withFileLock(LIKED_IDS_PATH, async () => {
    const data = await getLikedData();
    const existingSet = new Set(data.ids || []);
    for (const id of newIds) existingSet.add(id);
    const updated = { lastSyncTime: new Date().toISOString(), ids: Array.from(existingSet) };
    await fs.writeFile(LIKED_IDS_PATH, JSON.stringify(updated, null, 2));
    return updated;
  });
}


// ═══════════════════════════════════════════
// 私信视频提取
// ═══════════════════════════════════════════

async function fetchMessageVideos(maxCount = 50, onProgress, checkInterrupt) {
    const chromiumInstance = getChromium();

    const loggedIn = await checkLoginStatus();
    if (!loggedIn || !loggedIn.loggedIn) {
        throw new Error('未登录或 Cookie 已失效，请先绑定凭证');
    }

    const isDocker = fsSync.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
    const headless = isDocker || process.env.HEADLESS === 'true';

    const launchOptions = {
        headless: headless,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--ignore-certificate-errors',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        locale: 'zh-CN',
    };

    const context = await chromiumInstance.launchPersistentContext(USER_DATA_DIR, launchOptions);
    activeBrowser = context;

    // 注入 Cookie
    if (await fileExists(COOKIE_PATH)) {
        try {
            const cookieData = JSON.parse(await fs.readFile(COOKIE_PATH, 'utf8'));
            const sid = cookieData.sessionid;
            if (sid) {
                const cookieNames = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'];
                await context.addCookies(cookieNames.map(name => ({
                    name, value: sid, domain: '.douyin.com', path: '/'
                })));
                console.log('[私信同步] 已注入 cookie');
            }
        } catch (e) {
            console.error('[私信同步] 读取 cookie 文件失败:', e.message);
        }
    }

    const page = await context.newPage();

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // 收集到的视频 ID 集合（去重用）
    const collectedAwemeIds = new Set();
    const collectedItems = [];

    // 拦截 API 响应，提取 aweme_id
    page.on('response', async (response) => {
        try {
            const url = response.url();
            // 监控视频详情API和IM相关API
            if (!url.includes('/web/im/') && !url.includes('/aweme/') && !url.includes('/multi/aweme/')) return;

            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('json')) return;

            const text = await response.text();
            if (text.length < 100) return;

            // 提取 aweme_id
            const awemeMatches = text.match(/"aweme_id"\s*:\s*"(\d{15,})"/g);
            if (!awemeMatches) return;

            for (const match of awemeMatches) {
                if (collectedItems.length >= maxCount) break;
                if (checkInterrupt && checkInterrupt()) break;

                const idMatch = match.match(/"aweme_id"\s*:\s*"(\d+)"/);
                if (!idMatch) continue;
                const id = idMatch[1];
                if (collectedAwemeIds.has(id)) continue;
                collectedAwemeIds.add(id);

                collectedItems.push({
                    _source: 'message',
                    _refType: 'aweme_id',
                    _refValue: id,
                });

                if (onProgress) {
                    onProgress({ phase: '正在从私信中提取视频...', collected: collectedItems.length });
                }
            }
        } catch (err) { /* ignore */ }
    });

    try {
        if (onProgress) onProgress({ phase: '正在打开私信页面...', collected: 0 });

        // 使用正确的私信页面 URL
        await page.goto('https://www.douyin.com/chat?isPopup=1', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // 等待会话列表加载
        try {
            await page.waitForSelector('[class*="ConversationList"], [class*="conversationList"]', { timeout: 10000 });
            console.log('[私信同步] 会话列表已加载');
        } catch {
            console.log('[私信同步] 等待会话列表超时，尝试继续...');
        }

        if (onProgress) onProgress({ phase: '正在扫描会话列表...', collected: collectedItems.length });

        // 获取会话项
        let conversationItems = await page.$$('[class*="ConversationItem"]');
        if (conversationItems.length === 0) {
            // 备用选择器
            conversationItems = await page.$$('[class*="conversationItem"], [class*="conversation-item"]');
        }

        const maxConversations = Math.min(conversationItems.length, 20);
        console.log('[私信同步] 发现 ' + conversationItems.length + ' 个会话，将扫描前 ' + maxConversations + ' 个');

        for (let i = 0; i < maxConversations; i++) {
            if (collectedItems.length >= maxCount) break;
            if (checkInterrupt && checkInterrupt()) break;

            if (onProgress) {
                onProgress({ phase: '正在扫描第 ' + (i + 1) + '/' + maxConversations + ' 个会话...', collected: collectedItems.length });
            }

            try {
                // 重新获取会话项（DOM 可能因虚拟滚动变化）
                let items = await page.$$('[class*="ConversationItem"]');
                if (items.length === 0) items = await page.$$('[class*="conversationItem"]');
                if (i >= items.length) break;

                // 检查元素是否可见，跳过不可见的虚拟列表项
                const isVisible = await items[i].isVisible();
                if (!isVisible) {
                    console.log('[私信同步] 跳过不可见的会话 #' + (i + 1));
                    continue;
                }

                await items[i].click({ timeout: 5000 });
                
                // 智能等待会话消息区域加载及可能的视频拦截，最多等3000ms
                const clickStart = Date.now();
                const currentLen = collectedItems.length;
                while (Date.now() - clickStart < 3000) {
                    if (collectedItems.length > currentLen) break;
                    const hasMsgs = await page.evaluate(() => {
                        return !!document.querySelector('[class*="MessageList"], [class*="messageList"], [class*="MessageItem"], [class*="message-item"]');
                    });
                    if (hasMsgs && Date.now() - clickStart > 500) break;
                    await page.waitForTimeout(100);
                }

                // 在消息区域滚动加载更多历史消息
                const messageArea = await page.$('[class*="MessageList"], [class*="messageList"]');
                if (messageArea) {
                    for (let scroll = 0; scroll < 3; scroll++) {
                        if (collectedItems.length >= maxCount) break;
                        if (checkInterrupt && checkInterrupt()) break;
                        
                        const scrollLen = collectedItems.length;
                        await messageArea.evaluate(el => { el.scrollTop = 0; });
                        
                        const scrollStart = Date.now();
                        while (Date.now() - scrollStart < 2000) {
                            if (collectedItems.length > scrollLen) break;
                            await page.waitForTimeout(100);
                        }
                    }
                }
            } catch (err) {
                console.error('[私信同步] 扫描第 ' + (i + 1) + ' 个会话时出错:', err.message);
                continue;
            }
        }

        if (onProgress) {
            onProgress({ phase: '扫描完成，正在解析视频信息...', collected: collectedItems.length });
        }

        // 解析每个提取到的引用为完整视频信息（复用已登录的浏览器上下文，避免 IP 风控）
        const douyinLib = require('./douyin');
        const resolvedItems = [];

        for (let i = 0; i < collectedItems.length; i++) {
            if (checkInterrupt && checkInterrupt()) break;

            const ref = collectedItems[i];
            if (onProgress) {
                onProgress({ phase: '正在解析视频 ' + (i + 1) + '/' + collectedItems.length + '...', collected: resolvedItems.length });
            }

            try {
                let videoInfo;
                if (ref._refType === 'aweme_id') {
                    videoInfo = await fetchVideoInfoViaContext(context, ref._refValue, douyinLib);
                } else if (ref._refType === 'share_url') {
                    const resolved = await douyinLib.resolveShareUrl(ref._refValue);
                    if (resolved) {
                        const vid = douyinLib.extractVideoId(resolved);
                        if (vid) videoInfo = await fetchVideoInfoViaContext(context, vid, douyinLib);
                    }
                }

                if (videoInfo) {
                    resolvedItems.push(videoInfo);
                }
            } catch (err) {
                console.error('[私信同步] 解析视频引用失败 [' + ref._refType + ': ' + ref._refValue + ']:', err.message);
            }

            // 避免请求过快触发风控
            await new Promise(r => setTimeout(r, 800));
        }

        console.log('[私信同步] 完成，共解析 ' + resolvedItems.length + ' 个视频');
        return resolvedItems;
    } finally {
        try { await context.close(); } catch (e) { }
    }
}

/**
 * 在已登录的浏览器上下文里解析单个 aweme_id 为完整视频信息。
 * 优先方案：拦截分享页面 SSR 数据中的 item_list（最可靠）。
 */
async function fetchVideoInfoViaContext(context, awemeId, douyinLib) {
    const page = await context.newPage();
    try {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        const shareUrl = 'https://www.iesdouyin.com/share/video/' + awemeId + '/';
        await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 直接读取页面 HTML 后解析 _ROUTER_DATA / _SSR_DATA / item_list
        const html = await page.content();
        const item = extractItemFromHtml(html);
        if (item) {
            return douyinLib.normalizeVideoData(item);
        }

        // 兜底：在浏览器里直接调 web 详情 API（带认证 cookie）
        const apiData = await page.evaluate(async (id) => {
            try {
                const resp = await fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' + id + '&aid=6383', {
                    headers: { 'Accept': 'application/json' },
                    credentials: 'include',
                });
                if (!resp.ok) return null;
                return await resp.json();
            } catch (e) { return null; }
        }, awemeId);

        if (apiData && apiData.aweme_detail) {
            return douyinLib.normalizeVideoData(apiData.aweme_detail);
        }

        throw new Error('无法从分享页面提取视频信息');
    } finally {
        try { await page.close(); } catch (e) { }
    }
}

/**
 * 从分享页面 HTML 中提取 item_list[0]
 */
function extractItemFromHtml(html) {
    if (!html) return null;
    const tryParse = (marker) => {
        const idx = html.indexOf(marker);
        if (idx === -1) return null;
        const start = idx + marker.length;
        const end = html.indexOf('</script>', start);
        if (end === -1) return null;
        let jsonStr = html.substring(start, end).trim();
        if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
        try { return JSON.parse(jsonStr); } catch (e) { return null; }
    };
    const deepFind = (obj, k, d = 10) => {
        if (!obj || typeof obj !== 'object' || d <= 0) return null;
        if (obj[k] !== undefined) return obj;
        for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') {
                const r = deepFind(v, k, d - 1);
                if (r) return r;
            }
        }
        return null;
    };
    for (const marker of ['window._ROUTER_DATA = ', 'window._SSR_DATA = ']) {
        const data = tryParse(marker);
        if (!data) continue;
        const holder = deepFind(data, 'item_list');
        if (holder && Array.isArray(holder.item_list) && holder.item_list[0]) {
            const item = holder.item_list[0];
            if (item.video || item.images) return item;
        }
    }
    return null;
}

async function fetchUserPosts(secUid, maxCount = 50, onProgress = null, checkInterrupt = null, tabType = 'post') {
  if (activeBrowser) {
    throw new Error('已有一个浏览器窗口在运行，请先完成当前操作');
  }

  const tabLabel = tabType === 'like' ? '喜欢' : (tabType === 'favorite' ? '收藏' : '作品');
  const pw = getChromium();
  const isDocker = fsSync.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
  const headless = isDocker || process.env.HEADLESS === 'true';
  console.log(`[用户${tabLabel}同步] 启动浏览器同步用户 ${secUid} 的${tabLabel}，目标获取 ${maxCount} 条...`);

  const launchOptions = {
    headless: headless,
    viewport: { width: 1280, height: 1280 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
      '--ignore-certificate-errors',
      '--disk-cache-size=0',
      '--aggressive-cache-discard',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'zh-CN',
  };

  let context;
  try {
    context = await pw.launchPersistentContext(USER_DATA_DIR, launchOptions);
    activeBrowser = context;

    // 清除浏览器缓存，防止拦截到上一次用户的 API 响应
    const existingPages = context.pages();
    for (const p of existingPages) {
      try { await p.close(); } catch (e) {}
    }

    // 通过 CDP 清除 HTTP 缓存和网络相关存储
    try {
      const tempPage = await context.newPage();
      const cdpSession = await tempPage.context().newCDPSession(tempPage);
      await cdpSession.send('Network.clearBrowserCache');
      await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdpSession.detach();
      await tempPage.close();
      console.log(`[用户${tabLabel}同步] 已清除浏览器 HTTP 缓存`);
    } catch (e) {
      console.log(`[用户${tabLabel}同步] 清除缓存失败(非致命): ${e.message}`);
    }

    // 注入 cookies
    if (await fileExists(COOKIE_PATH)) {
      try {
        const cookieData = JSON.parse(await fs.readFile(COOKIE_PATH, 'utf8'));
        const sid = cookieData.sessionid;
        if (sid) {
          const cookieNames = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'];
          await context.addCookies(cookieNames.map(name => ({
            name, value: sid, domain: '.douyin.com', path: '/'
          })));
          console.log(`[用户${tabLabel}同步] 已成功从本地文件注入 Cookie`);
        }
      } catch (e) {
        console.error(`[用户${tabLabel}同步] 读取本地 cookie 失败:`, e.message);
      }
    }
  } catch (err) {
    console.error(`[用户${tabLabel}同步] 启动浏览器失败:`, err.message);
    throw new Error(`启动失败: ${err.message}`);
  }

  try {
    const page = await context.newPage();

    page.on('dialog', async dialog => {
      try { await dialog.dismiss(); } catch (e) {}
    });

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const collected = [];
    const seenIds = new Set();
    let hasMore = true;
    let nickname = '抖音用户';
    let pageNavigated = false; // 确保只在页面导航后才采集数据

    page.on('response', async (response) => {
      if (!pageNavigated) return; // 忽略导航前的残留缓存响应

      const url = response.url();
      // 更精准的 API URL 匹配
      let isTargetApi = false;
      if (tabType === 'like') {
        isTargetApi = url.includes('/aweme/v1/web/aweme/favorite') ||
                     url.includes('aweme/v1/web/aweme/listfavorite') ||
                     (url.includes('/like') && url.includes('sec_user_id'));
      } else if (tabType === 'favorite') {
        // 收藏列表使用 collect 相关 API，注意不要匹配到 /aweme/favorite（那是喜欢列表）
        isTargetApi = (url.includes('collect') && !url.includes('/aweme/v1/web/aweme/favorite')) ||
                     url.includes('collects_list') ||
                     url.includes('collect/list') ||
                     (url.includes('aweme_list') && url.includes('collect'));
      } else {
        isTargetApi = url.includes('aweme/v1/web/aweme/post') ||
                     (url.includes('aweme/post') && url.includes('device_platform=webapp'));
      }
      if (!isTargetApi) return;

      // 验证响应属于目标用户 — 仅对 post 类型严格校验
      // favorite/like API 可能使用登录用户的 sec_uid 来查看别人的公开内容
      if (tabType === 'post' && (url.includes('sec_user_id') || url.includes('sec_uid'))) {
        const urlSecUid = url.match(/sec_(?:user_id|uid)=([^&]+)/);
        if (urlSecUid && urlSecUid[1] !== secUid) {
          console.log(`[用户${tabLabel}同步] ⚠️ 忽略非目标用户的 API 响应`);
          return;
        }
      }

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json') && !contentType.includes('text')) return;

      try {
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { return; }

        let awemeList = json.aweme_list || [];
        if (tabType === 'like' || tabType === 'favorite') {
          if (awemeList.length === 0 && json.data && json.data.aweme_list) awemeList = json.data.aweme_list;
          if (awemeList.length === 0 && json.collects_list) awemeList = json.collects_list;
          if (awemeList.length === 0 && json.data && json.data.collects_list) awemeList = json.data.collects_list;
        }

        if (awemeList.length === 0) return;

        console.log(`[用户${tabLabel}同步] ✅ 拦截到${tabLabel} API，包含 ${awemeList.length} 条${tabLabel}`);

        for (const item of awemeList) {
          if (collected.length >= maxCount) break;
          const awemeId = item.aweme_id || '';
          if (!awemeId || seenIds.has(awemeId)) continue;
          seenIds.add(awemeId);
          collected.push(item);

          if (onProgress) {
            onProgress(collected.length, maxCount, { awemeId, title: item.desc || '未知标题', nickname });
          }
        }
        if (json.has_more === false || json.has_more === 0) hasMore = false;
      } catch (err) { }
    });

    console.log(`[用户${tabLabel}同步] 正在打开用户主页 https://www.douyin.com/user/${secUid} ...`);
    await page.goto(`https://www.douyin.com/user/${secUid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    pageNavigated = true; // 从此刻开始才采集 API 响应
    
    // 智能等待主页信息加载，最多 5 秒
    const pageLoadStart = Date.now();
    while (Date.now() - pageLoadStart < 5000) {
      const title = await page.title().catch(() => '');
      if (title && (title.includes('的主页') || title.includes('的作品'))) break;
      await page.waitForTimeout(100);
    }

    // 从网页标题获取资料页主人昵称（非视频作者）
    try {
      const pageTitle = await page.title();
      if (pageTitle && pageTitle.includes('的主页')) {
        nickname = pageTitle.split('的主页')[0].trim();
      } else if (pageTitle && pageTitle.includes('的作品')) {
        nickname = pageTitle.split('的作品')[0].trim();
      }
      // 备选：从页面 DOM 中获取用户昵称
      if (nickname === '抖音用户') {
        const nameFromDom = await page.$eval('[data-e2e="user-info"] .user-name, h1[class*="name"], span[class*="nickname"]', el => el.textContent?.trim()).catch(() => null);
        if (nameFromDom) nickname = nameFromDom;
      }
    } catch (e) {}
    console.log(`[用户${tabLabel}同步] 识别到用户昵称: ${nickname}`);

    if (tabType === 'like' || tabType === 'favorite') {
      let clickedTab = false;
      let tabSelectors, tabTexts, fallbackUrl;

      if (tabType === 'like') {
        tabSelectors = ['[data-e2e="user-tab-like"]'];
        tabTexts = ['喜欢'];
        fallbackUrl = `https://www.douyin.com/user/${secUid}?showTab=like`;
      } else {
        tabSelectors = ['[data-e2e="user-tab-favorite"]', '[data-e2e="user-tab-collection"]'];
        tabTexts = ['收藏'];
        fallbackUrl = `https://www.douyin.com/user/${secUid}?showTab=favorite`;
      }

      for (const sel of tabSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clickedTab = true;
          console.log(`[用户${tabLabel}同步] 通过选择器 ${sel} 点击了${tabLabel} tab`);
          break;
        }
      }

      if (!clickedTab) {
        // 尝试通过 locator 精确匹配 tab 文字（排除子 tab）
        for (const text of tabTexts) {
          try {
            // 先尝试精确匹配主 tab 区域
            const tabEl = await page.locator(`[class*="tab"] span:text-is("${text}"), [role="tab"]:has-text("${text}")`).first();
            if (await tabEl.isVisible({ timeout: 2000 })) {
              await tabEl.click();
              clickedTab = true;
              console.log(`[用户${tabLabel}同步] 通过精确文字 "${text}" 点击了${tabLabel} tab`);
              break;
            }
          } catch (e) { }
          try {
            const tabEl = await page.locator(`span:has-text("${text}")`).first();
            if (await tabEl.isVisible({ timeout: 1000 })) {
              await tabEl.click();
              clickedTab = true;
              console.log(`[用户${tabLabel}同步] 通过文字 "${text}" 点击了${tabLabel} tab`);
              break;
            }
          } catch (e) { }
        }
      }

      if (!clickedTab) {
        console.log(`[用户${tabLabel}同步] ⚠️ 未能点击${tabLabel} tab，尝试直接导航`);
        try {
          await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (err) {
          console.log(`[用户${tabLabel}同步] 导航可能超时，忽略继续: ${err.message}`);
        }
      }

      await page.waitForTimeout(1500);

      // 收藏 tab 下有子 tab: "收藏夹"、"视频"、"音乐"
      // 对于 tabType='favorite'（普通收藏），需要点击"视频"子 tab
      if (tabType === 'favorite') {
        try {
          const videoSubTab = await page.locator('span:text-is("视频"), div:text-is("视频")').first();
          if (await videoSubTab.isVisible({ timeout: 2000 })) {
            await videoSubTab.click();
            console.log(`[用户${tabLabel}同步] 点击了"视频"子 tab`);
            await page.waitForTimeout(1000);
          }
        } catch (e) {
          console.log(`[用户${tabLabel}同步] 未找到"视频"子 tab，继续使用默认视图`);
        }
      }
      
      // 智能等待，若收集列表尚无数据，最多等 6 秒
      const clickTabStart = Date.now();
      while (collected.length === 0 && Date.now() - clickTabStart < 6000) {
        await page.waitForTimeout(100);
      }
    }

    console.log(`[用户${tabLabel}同步] 开始滚动加载... 当前用户: ${nickname}`);

    let scrollAttempts = 0;
    const maxScrollAttempts = 60;
    let lastCollectedCount = 0;
    let staleScrolls = 0;

    while (collected.length < maxCount && hasMore && scrollAttempts < maxScrollAttempts) {
      if (checkInterrupt && checkInterrupt()) break;
      scrollAttempts++;
      try {
        await Promise.race([
          page.evaluate(() => window.scrollBy(0, 800)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3000))
        ]);
      } catch (e) {
        break;
      }
      
      const currentCount = collected.length;
      const scrollWaitStart = Date.now();
      const maxScrollWait = 2500 + Math.random() * 2000;
      while (collected.length === currentCount && Date.now() - scrollWaitStart < maxScrollWait) {
        await page.waitForTimeout(100);
      }
      
      if (collected.length === lastCollectedCount) {
        staleScrolls++;
        if (staleScrolls >= 10) break;
      } else {
        staleScrolls = 0;
        lastCollectedCount = collected.length;
      }
    }

    console.log(`[用户${tabLabel}同步] 收集${tabLabel}完成，共抓取到 ${collected.length} 条`);
    return { items: collected, nickname };
  } finally {
    activeBrowser = null;
    try { await context.close(); } catch (e) { }
  }
}

/**
 * 同步用户收藏夹（文件夹模式）
 * 抖音用户"收藏"tab 下会有命名收藏夹，需要先列出文件夹，再逐个进入采集视频。
 */
async function fetchUserCollections(secUid, maxCount = 200, onProgress = null, checkInterrupt = null) {
  if (activeBrowser) {
    throw new Error('已有一个浏览器窗口在运行，请先完成当前操作');
  }

  const pw = getChromium();
  const isDocker = fsSync.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
  const headless = isDocker || process.env.HEADLESS === 'true';
  console.log(`[收藏夹同步] 启动浏览器同步用户 ${secUid} 的收藏夹，目标获取 ${maxCount} 条...`);

  const launchOptions = {
    headless: headless,
    viewport: { width: 1280, height: 1280 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
      '--ignore-certificate-errors',
      '--disk-cache-size=0',
      '--aggressive-cache-discard',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'zh-CN',
  };

  let context;
  try {
    context = await pw.launchPersistentContext(USER_DATA_DIR, launchOptions);
    activeBrowser = context;

    // 清除残留页面
    const existingPages = context.pages();
    for (const p of existingPages) {
      try { await p.close(); } catch (e) {}
    }

    // 通过 CDP 清除 HTTP 缓存
    try {
      const tempPage = await context.newPage();
      const cdpSession = await tempPage.context().newCDPSession(tempPage);
      await cdpSession.send('Network.clearBrowserCache');
      await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdpSession.detach();
      await tempPage.close();
      console.log(`[收藏夹同步] 已清除浏览器 HTTP 缓存`);
    } catch (e) {
      console.log(`[收藏夹同步] 清除缓存失败(非致命): ${e.message}`);
    }

    // 注入 cookies
    if (await fileExists(COOKIE_PATH)) {
      try {
        const cookieData = JSON.parse(await fs.readFile(COOKIE_PATH, 'utf8'));
        const sid = cookieData.sessionid;
        if (sid) {
          const cookieNames = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'];
          await context.addCookies(cookieNames.map(name => ({
            name, value: sid, domain: '.douyin.com', path: '/'
          })));
          console.log(`[收藏夹同步] 已成功从本地文件注入 Cookie`);
        }
      } catch (e) {
        console.error(`[收藏夹同步] 读取本地 cookie 失败:`, e.message);
      }
    }
  } catch (err) {
    console.error(`[收藏夹同步] 启动浏览器失败:`, err.message);
    throw new Error(`启动失败: ${err.message}`);
  }

  try {
    const page = await context.newPage();
    page.on('dialog', async dialog => {
      try { await dialog.dismiss(); } catch (e) {}
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    let nickname = '抖音用户';

    // 导航到用户主页
    console.log(`[收藏夹同步] 正在打开用户主页 https://www.douyin.com/user/${secUid} ...`);
    await page.goto(`https://www.douyin.com/user/${secUid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 等待页面加载
    const pageLoadStart = Date.now();
    while (Date.now() - pageLoadStart < 5000) {
      const title = await page.title().catch(() => '');
      if (title && (title.includes('的主页') || title.includes('的作品'))) break;
      await page.waitForTimeout(100);
    }

    // 获取昵称
    try {
      const pageTitle = await page.title();
      if (pageTitle && pageTitle.includes('的主页')) {
        nickname = pageTitle.split('的主页')[0].trim();
      } else if (pageTitle && pageTitle.includes('的作品')) {
        nickname = pageTitle.split('的作品')[0].trim();
      }
      if (nickname === '抖音用户') {
        const nameFromDom = await page.$eval('[data-e2e="user-info"] .user-name, h1[class*="name"], span[class*="nickname"]', el => el.textContent?.trim()).catch(() => null);
        if (nameFromDom) nickname = nameFromDom;
      }
    } catch (e) {}
    console.log(`[收藏夹同步] 识别到用户昵称: ${nickname}`);

    // 点击"收藏" tab
    let clickedTab = false;
    const tabSelectors = ['[data-e2e="user-tab-favorite"]', '[data-e2e="user-tab-collection"]'];
    for (const sel of tabSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        clickedTab = true;
        console.log(`[收藏夹同步] 通过选择器 ${sel} 点击了收藏 tab`);
        break;
      }
    }
    if (!clickedTab) {
      try {
        const tabEl = await page.locator('[class*="tab"] span:text-is("收藏"), [role="tab"]:has-text("收藏")').first();
        if (await tabEl.isVisible({ timeout: 2000 })) {
          await tabEl.click();
          clickedTab = true;
          console.log(`[收藏夹同步] 通过精确文字点击了收藏 tab`);
        }
      } catch (e) {}
      if (!clickedTab) {
        try {
          const tabEl = await page.locator('span:has-text("收藏")').first();
          if (await tabEl.isVisible({ timeout: 1000 })) {
            await tabEl.click();
            clickedTab = true;
            console.log(`[收藏夹同步] 通过文字"收藏"点击了收藏 tab`);
          }
        } catch (e) {}
      }
    }
    if (!clickedTab) {
      try {
        await page.goto(`https://www.douyin.com/user/${secUid}?showTab=favorite`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        console.log(`[收藏夹同步] 通过 URL 导航到收藏 tab`);
      } catch (err) {
        console.log(`[收藏夹同步] 导航到收藏 tab 可能超时，忽略继续`);
      }
    }

    await page.waitForTimeout(2000);

    // 收藏 tab 下有子 tab: "收藏夹"、"视频"、"音乐"
    // 需要点击"收藏夹"子 tab 进入收藏夹列表
    try {
      const folderSubTab = await page.locator('span:text-is("收藏夹"), div:text-is("收藏夹")').first();
      if (await folderSubTab.isVisible({ timeout: 2000 })) {
        await folderSubTab.click();
        console.log(`[收藏夹同步] 点击了"收藏夹"子 tab`);
        await page.waitForTimeout(2000);
      } else {
        console.log(`[收藏夹同步] 未找到"收藏夹"子 tab，尝试当前视图`);
      }
    } catch (e) {
      console.log(`[收藏夹同步] 查找"收藏夹"子 tab 出错: ${e.message}`);
    }

    // 检测收藏夹列表
    // 先截图调试当前页面状态
    const debugScreenPath = path.resolve('collection_debug.png');
    try { await page.screenshot({ path: debugScreenPath, fullPage: false }); } catch (e) {}

    // 尝试多种选择器来找到收藏夹列表项
    const folderSelectors = [
      '[data-e2e="user-collection-item"]',
      '[data-e2e="favorites-item"]',
      '.collection-item',
      '[class*="CollectionItem"]',
      '[class*="collection-card"]',
      '[class*="FavoriteFolder"]',
      '[class*="favoriteCollection"]',
      '[class*="CollectionCard"]',
      'li[class*="collection"]',
      'div[class*="collection"]',
    ];

    let folders = [];
    for (const sel of folderSelectors) {
      const elements = await page.$$(sel);
      if (elements.length > 0) {
        console.log(`[收藏夹同步] 通过选择器 ${sel} 找到 ${elements.length} 个收藏夹`);
        for (const el of elements) {
          const text = await el.textContent().catch(() => '');
          folders.push({ element: el, name: text.trim().split('\n')[0] || '未命名收藏夹' });
        }
        break;
      }
    }

    // 备选：通过链接 href 包含 collection 或 favorite
    if (folders.length === 0) {
      const links = await page.$$('a[href*="collection"], a[href*="favoriteCollection"]');
      if (links.length > 0) {
        console.log(`[收藏夹同步] 通过链接找到 ${links.length} 个收藏夹`);
        for (const link of links) {
          const text = await link.textContent().catch(() => '');
          const href = await link.getAttribute('href').catch(() => '');
          if (href) {
            folders.push({ element: link, name: text.trim().split('\n')[0] || '未命名收藏夹', href });
          }
        }
      }
    }

    // 备选：包含"个作品"或"个视频"或"关注"字样的可点击卡片
    if (folders.length === 0) {
      const allElements = await page.$$('a, div[class*="card"], div[class*="Card"], div[class*="item"], li');
      for (const el of allElements) {
        const text = await el.textContent().catch(() => '');
        if ((text.includes('个作品') || text.includes('个视频') || text.includes('人关注')) && text.length < 200) {
          const href = await el.getAttribute('href').catch(() => null);
          const cardName = text.trim().split('\n')[0] || '未命名收藏夹';
          // 排除太大的容器元素
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width < 600 && box.height < 400) {
            folders.push({ element: el, name: cardName, href: href || undefined });
          }
        }
      }
      if (folders.length > 0) {
        console.log(`[收藏夹同步] 通过内容模式找到 ${folders.length} 个收藏夹`);
      }
    }

    // 最后手段：打印页面关键 HTML 结构用于调试
    if (folders.length === 0) {
      const pageContent = await page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        return main.innerHTML.substring(0, 2000);
      }).catch(() => '');
      console.log(`[收藏夹同步] 页面结构前2000字符: ${pageContent.substring(0, 500)}`);
    }

    if (folders.length === 0) {
      console.log(`[收藏夹同步] 未检测到收藏夹结构，回退到普通收藏列表模式`);
      // 回退：直接作为普通收藏列表处理
      await context.close();
      activeBrowser = null;
      return await fetchUserPosts(secUid, maxCount, onProgress, checkInterrupt, 'favorite');
    }

    console.log(`[收藏夹同步] 共检测到 ${folders.length} 个收藏夹`);
    if (onProgress) {
      onProgress(0, maxCount, { awemeId: '', title: `发现 ${folders.length} 个收藏夹，开始逐个采集...`, nickname });
    }

    // 逐个进入收藏夹采集视频
    const allCollected = [];
    const seenIds = new Set();

    for (let fi = 0; fi < folders.length; fi++) {
      if (checkInterrupt && checkInterrupt()) break;
      if (allCollected.length >= maxCount) break;

      const folder = folders[fi];
      console.log(`[收藏夹同步] 进入第 ${fi + 1}/${folders.length} 个收藏夹: ${folder.name}`);

      if (onProgress) {
        onProgress(allCollected.length, maxCount, { awemeId: '', title: `正在采集收藏夹: ${folder.name} (${fi + 1}/${folders.length})`, nickname });
      }

      // 收集当前收藏夹内的视频
      const folderItems = [];
      let folderHasMore = true;
      let folderPageNavigated = false;

      // 注册拦截器
      const responseHandler = async (response) => {
        if (!folderPageNavigated) return;
        const url = response.url();
        const isTargetApi = url.includes('collection') || url.includes('collects_list') || 
                           url.includes('collect/list') || url.includes('favorite/list') ||
                           url.includes('aweme_list') || url.includes('aweme/v1');
        if (!isTargetApi) return;

        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json') && !contentType.includes('text')) return;

        try {
          const text = await response.text();
          let json;
          try { json = JSON.parse(text); } catch { return; }

          let awemeList = json.aweme_list || [];
          if (awemeList.length === 0 && json.data && json.data.aweme_list) awemeList = json.data.aweme_list;
          if (awemeList.length === 0 && json.collects_list) awemeList = json.collects_list;
          if (awemeList.length === 0 && json.data && json.data.collects_list) awemeList = json.data.collects_list;

          if (awemeList.length === 0) return;
          console.log(`[收藏夹同步] ✅ 收藏夹"${folder.name}"拦截到 ${awemeList.length} 条视频`);

          for (const item of awemeList) {
            if (allCollected.length >= maxCount) break;
            const awemeId = item.aweme_id || '';
            if (!awemeId || seenIds.has(awemeId)) continue;
            seenIds.add(awemeId);
            // 标记来自哪个收藏夹
            item._collectionName = folder.name;
            folderItems.push(item);
            allCollected.push(item);

            if (onProgress) {
              onProgress(allCollected.length, maxCount, { awemeId, title: item.desc || '未知标题', nickname });
            }
          }
          if (json.has_more === false || json.has_more === 0) folderHasMore = false;
        } catch (err) {}
      };

      page.on('response', responseHandler);

      try {
        // 点击进入收藏夹
        if (folder.href) {
          const fullUrl = folder.href.startsWith('http') ? folder.href : `https://www.douyin.com${folder.href}`;
          await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } else {
          await folder.element.click();
          await page.waitForTimeout(1500);
        }
        folderPageNavigated = true;

        // 等待数据出现
        const waitStart = Date.now();
        while (folderItems.length === 0 && Date.now() - waitStart < 6000) {
          await page.waitForTimeout(200);
        }

        // 滚动加载更多
        let scrollAttempts = 0;
        const maxScrollPerFolder = 30;
        let lastCount = 0;
        let staleScrolls = 0;

        while (allCollected.length < maxCount && folderHasMore && scrollAttempts < maxScrollPerFolder) {
          if (checkInterrupt && checkInterrupt()) break;
          scrollAttempts++;
          try {
            await Promise.race([
              page.evaluate(() => window.scrollBy(0, 800)),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
            ]);
          } catch (e) { break; }

          const currentCount = folderItems.length;
          const scrollWait = Date.now();
          while (folderItems.length === currentCount && Date.now() - scrollWait < 3000) {
            await page.waitForTimeout(100);
          }

          if (folderItems.length === lastCount) {
            staleScrolls++;
            if (staleScrolls >= 6) break;
          } else {
            staleScrolls = 0;
            lastCount = folderItems.length;
          }
        }

        console.log(`[收藏夹同步] 收藏夹"${folder.name}"采集完成，共 ${folderItems.length} 条`);
      } finally {
        page.removeListener('response', responseHandler);
      }

      // 返回收藏 tab 页面准备进入下一个收藏夹
      if (fi < folders.length - 1 && allCollected.length < maxCount) {
        try {
          await page.goto(`https://www.douyin.com/user/${secUid}?showTab=favorite`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(2000);

          // 重新获取收藏夹列表元素（因为页面已重新加载）
          let newFolders = [];
          for (const sel of folderSelectors) {
            const elements = await page.$$(sel);
            if (elements.length > 0) {
              for (const el of elements) {
                const text = await el.textContent().catch(() => '');
                newFolders.push({ element: el, name: text.trim().split('\n')[0] || '未命名收藏夹' });
              }
              break;
            }
          }
          if (newFolders.length === 0) {
            const links = await page.$$('a[href*="collection"]');
            for (const link of links) {
              const text = await link.textContent().catch(() => '');
              const href = await link.getAttribute('href').catch(() => '');
              if (href && href.includes('collection')) {
                newFolders.push({ element: link, name: text.trim().split('\n')[0] || '未命名收藏夹', href });
              }
            }
          }
          if (newFolders.length === 0) {
            const cards = await page.$$('[class*="card"], [class*="Card"]');
            for (const card of cards) {
              const text = await card.textContent().catch(() => '');
              if (text.includes('个作品') || text.includes('个视频')) {
                newFolders.push({ element: card, name: text.trim().split('\n')[0] || '未命名收藏夹' });
              }
            }
          }

          // 更新剩余的 folders 引用
          if (newFolders.length > fi + 1) {
            folders[fi + 1] = newFolders[fi + 1];
          }
        } catch (e) {
          console.log(`[收藏夹同步] 返回收藏列表失败: ${e.message}`);
          break;
        }
      }
    }

    console.log(`[收藏夹同步] 全部收藏夹采集完成，共 ${allCollected.length} 条视频`);
    return { items: allCollected, nickname };
  } finally {
    activeBrowser = null;
    try { await context.close(); } catch (e) { }
  }
}

module.exports = {
  checkLoginStatus,
  openLoginBrowser,
  getLoginQr: () => currentQrCode,
  fetchFavorites,
  fetchLikedVideos,
  logout,
  getSyncedData,
  saveSyncedIds,
  getLikedData,
  saveLikedIds,
  loginWithCookie,
  fetchMessageVideos,
  fetchUserPosts,
  fetchUserCollections,
};
