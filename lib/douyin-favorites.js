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
    // 保存一张截图以诊断无头模式为何找不到视频（写入 user_data，避免暴露到 public 静态目录）
    try {
      const debugDir = path.join(BASE_DIR, 'user_data', 'debug');
      await fs.mkdir(debugDir, { recursive: true });
      await page.screenshot({ path: path.join(debugDir, 'fav_debug.png'), fullPage: false });
      console.log(`[${tabLabel}] 已保存诊断截图 user_data/debug/fav_debug.png`);
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
    // 注意：activeBrowser 是 launchPersistentContext 返回的 BrowserContext，
    // 它没有 .contexts() 方法（那是 Browser 的方法）。之前的写法会抛 TypeError
    // 并被 catch 吞掉，导致 cookies 未清理、浏览器进程泄漏。改为直接清理。
    try {
      await activeBrowser.clearCookies();
    } catch (e) {
      console.error('[退出登录] 清理 cookies 失败:', e.message);
    }
    try {
      await activeBrowser.close();
    } catch (e) {
      console.error('[退出登录] 关闭浏览器失败:', e.message);
    }
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
    const cachedVideoDetails = new Map();
    const douyinLib = require('./douyin');

    // 拦截 API 响应，提取 aweme_id 以及直接缓存 aweme_details
    page.on('response', async (response) => {
        try {
            const url = response.url();

            // 1. 优先捕获抖音 Web 端批量/单个视频详情响应，直接解析为完整视频信息缓存起来
            if (url.includes('/aweme/v1/web/multi/aweme/detail') || url.includes('/aweme/v1/web/aweme/detail')) {
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('json')) {
                    try {
                        const json = await response.json();
                        const list = json.aweme_details || (json.aweme_detail ? [json.aweme_detail] : []);
                        for (const item of list) {
                            if (item && item.aweme_id) {
                                try {
                                    const normalized = douyinLib.normalizeVideoData(item);
                                    cachedVideoDetails.set(item.aweme_id, normalized);
                                } catch (e) { }

                                if (!collectedAwemeIds.has(item.aweme_id)) {
                                    collectedAwemeIds.add(item.aweme_id);
                                    collectedItems.push({
                                        _source: 'message',
                                        _refType: 'aweme_id',
                                        _refValue: item.aweme_id,
                                    });
                                    if (onProgress) {
                                        onProgress({ phase: '正在从私信中提取视频...', collected: collectedItems.length });
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                }
            }

            // 2. 监控 IM 相关 API 及含有 aweme_id 的 JSON
            if (!url.includes('/web/im/') && !url.includes('/aweme/') && !url.includes('imapi.douyin.com')) return;

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

        // 尝试关闭遮挡弹窗（例如“是否保存登录信息？”或提示窗）
        try {
            await page.waitForTimeout(1000);
            const modalCancel = await page.$('button:has-text("取消"), div[class*="semi-modal"] button:has-text("取消"), .semi-modal-close');
            if (modalCancel) {
                await modalCancel.click();
                console.log('[私信同步] 已关闭提示弹窗');
            }
        } catch (e) { }

        // 等待会话列表加载（headless 冷启动下抖音页面加载慢，10s 常不够，
        // 2026-10-09 起放宽到 60s：等不到位会导致只扫到极少数会话，漏掉新私信视频）
        try {
            await page.waitForSelector('div[class*="conversationConversationItemwrapper"], [class*="ConversationItem"], [class*="conversationConversationList"], [class*="ConversationList"]', { timeout: 60000 });
            console.log('[私信同步] 会话列表已加载');
        } catch {
            console.log('[私信同步] 等待会话列表超时（60s），尝试继续...');
        }

        // 再次检测关闭可能弹出的弹窗
        try {
            const cancelBtn = await page.$('button:has-text("取消"), .semi-modal-close');
            if (cancelBtn) await cancelBtn.click();
        } catch (e) { }

        if (onProgress) onProgress({ phase: '正在扫描会话列表...', collected: collectedItems.length });

        // 获取会话项
        let conversationItems = await page.$$('div[class*="conversationConversationItemwrapper"]');
        if (conversationItems.length === 0) {
            conversationItems = await page.$$('div[class*="conversationConversationItem"]');
        }
        if (conversationItems.length === 0) {
            conversationItems = await page.$$('[class*="ConversationItem"]:not([class*="wrapper"])');
        }
        if (conversationItems.length === 0) {
            conversationItems = await page.$$('[class*="ConversationItem"], [class*="conversationItem"], [class*="conversation-item"]');
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
                let items = await page.$$('div[class*="conversationConversationItemwrapper"]');
                if (items.length === 0) items = await page.$$('div[class*="conversationConversationItem"]');
                if (items.length === 0) items = await page.$$('[class*="ConversationItem"]:not([class*="wrapper"])');
                if (items.length === 0) items = await page.$$('[class*="ConversationItem"]');
                if (i >= items.length) break;

                // 检查元素是否可见，跳过不可见的虚拟列表项
                const isVisible = await items[i].isVisible();
                if (!isVisible) {
                    console.log('[私信同步] 跳过不可见的会话 #' + (i + 1));
                    continue;
                }

                await items[i].click({ timeout: 5000 });
                await page.waitForTimeout(1500);

                // 在消息区域滚动加载更多历史消息
                const messageArea = await page.$('div[class*="messageList"], div[class*="MessageList"], div[class*="ChatContent"]');
                if (messageArea) {
                    for (let scroll = 0; scroll < 4; scroll++) {
                        if (collectedItems.length >= maxCount) break;
                        if (checkInterrupt && checkInterrupt()) break;

                        const scrollLen = collectedItems.length;
                        await messageArea.evaluate(el => { el.scrollTop = 0; });

                        const scrollStart = Date.now();
                        while (Date.now() - scrollStart < 1500) {
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

        const resolvedItems = [];

        for (let i = 0; i < collectedItems.length; i++) {
            if (checkInterrupt && checkInterrupt()) break;

            const ref = collectedItems[i];
            if (onProgress) {
                onProgress({ phase: '正在解析视频 ' + (i + 1) + '/' + collectedItems.length + '...', collected: resolvedItems.length });
            }

            try {
                let videoInfo = null;
                if (ref._refType === 'aweme_id') {
                    if (cachedVideoDetails.has(ref._refValue)) {
                        videoInfo = cachedVideoDetails.get(ref._refValue);
                    } else {
                        videoInfo = await fetchVideoInfoViaContext(context, ref._refValue, douyinLib);
                    }
                } else if (ref._refType === 'share_url') {
                    const resolved = await douyinLib.resolveShareUrl(ref._refValue);
                    if (resolved) {
                        const vid = douyinLib.extractVideoId(resolved);
                        if (vid) {
                            if (cachedVideoDetails.has(vid)) {
                                videoInfo = cachedVideoDetails.get(vid);
                            } else {
                                videoInfo = await fetchVideoInfoViaContext(context, vid, douyinLib);
                            }
                        }
                    }
                }

                if (videoInfo) {
                    resolvedItems.push(videoInfo);
                }
            } catch (err) {
                console.error('[私信同步] 解析视频引用失败 [' + ref._refType + ': ' + ref._refValue + ']:', err.message);
            }

            // 避免请求过快触发风控（已有缓存则无需等待）
            if (!cachedVideoDetails.has(ref._refValue)) {
                await new Promise(r => setTimeout(r, 600));
            }
        }

        console.log('[私信同步] 完成，共解析 ' + resolvedItems.length + ' 个视频');
        return resolvedItems;
    } finally {
        activeBrowser = null;
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

    // 通过 CDP 清除 HTTP 缓存和 Service Worker 缓存
    try {
      const tempPage = await context.newPage();
      const cdpSession = await tempPage.context().newCDPSession(tempPage);
      await cdpSession.send('Network.clearBrowserCache');
      await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });
      // 清除 Service Worker 缓存，防止 SW 返回旧用户的页面/昵称
      try {
        await cdpSession.send('ServiceWorker.enable');
        await cdpSession.send('ServiceWorker.stopAllWorkers');
      } catch (e2) { /* 部分环境不支持，忽略 */ }
      await cdpSession.detach();
      await tempPage.close();
      console.log(`[用户${tabLabel}同步] 已清除浏览器缓存`);
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

    // 拦截用户 profile API 获取正确的昵称（最可靠来源）
    page.on('response', async (response) => {
      if (!pageNavigated) return; // 忽略导航前的残留缓存响应

      const url = response.url();
      if (url.includes('/user/profile/other') || url.includes('/user/profile/self')) {
        try {
          const text = await response.text();
          const json = JSON.parse(text);
          const user = json.user || (json.data && json.data.user) || (json.user_info);
          if (user && user.nickname) {
            // 验证是目标用户（sec_uid 匹配或 URL 参数包含）
            const isTarget = (user.sec_uid === secUid) || 
                           url.includes(secUid) || 
                           (user.unique_id && page.url().includes(secUid));
            if (isTarget) {
              nickname = user.nickname;
              console.log(`[用户${tabLabel}同步] 从 profile API 获取昵称: ${nickname}`);
            }
          }
        } catch (e) {}
      }
    });

    page.on('response', async (response) => {
      if (!pageNavigated) return; // 忽略导航前的残留缓存响应

      const url = response.url();
      
      // 更精准的 API URL 匹配（仅支持 post 和 like）
      let isTargetApi = false;
      if (tabType === 'like') {
        isTargetApi = url.includes('/aweme/v1/web/aweme/favorite') ||
                     url.includes('aweme/v1/web/aweme/listfavorite') ||
                     (url.includes('/like') && url.includes('sec_user_id'));
      } else {
        // post（作品）
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
    
    // 等待 profile API 返回正确昵称（最多等 5 秒）
    const nicknameWaitStart = Date.now();
    while (nickname === '抖音用户' && Date.now() - nicknameWaitStart < 5000) {
      await page.waitForTimeout(300);
    }

    // 如果 profile API 未拦截到昵称，尝试从页面标题获取（fallback）
    if (nickname === '抖音用户') {
      try {
        const pageTitle = await page.title();
        const currentUrl = page.url();
        if (currentUrl.includes(secUid)) {
          if (pageTitle && pageTitle.includes('的主页')) {
            nickname = pageTitle.split('的主页')[0].trim();
          } else if (pageTitle && pageTitle.includes('的作品')) {
            nickname = pageTitle.split('的作品')[0].trim();
          }
        }
        // 备选：从页面 DOM 中获取用户昵称
        if (nickname === '抖音用户') {
          const nameFromDom = await page.$eval('[data-e2e="user-info"] .user-name, h1[class*="name"], span[class*="nickname"]', el => el.textContent?.trim()).catch(() => null);
          if (nameFromDom) nickname = nameFromDom;
        }
      } catch (e) {}
    }
    console.log(`[用户${tabLabel}同步] 识别到用户昵称: ${nickname}`);

    if (tabType === 'like') {
      let clickedTab = false;
      const tabSelectors = ['[data-e2e="user-tab-like"]'];
      const tabTexts = ['喜欢'];
      const fallbackUrl = `https://www.douyin.com/user/${secUid}?showTab=like`;

      for (const sel of tabSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clickedTab = true;
          console.log(`[用户${tabLabel}同步] 通过选择器 ${sel} 点击了喜欢 tab`);
          break;
        }
      }

      if (!clickedTab) {
        for (const text of tabTexts) {
          try {
            const tabEl = await page.locator(`[class*="tab"] span:text-is("${text}"), [role="tab"]:has-text("${text}")`).first();
            if (await tabEl.isVisible({ timeout: 2000 })) {
              await tabEl.click();
              clickedTab = true;
              console.log(`[用户${tabLabel}同步] 通过精确文字 "${text}" 点击了喜欢 tab`);
              break;
            }
          } catch (e) { }
          try {
            const tabEl = await page.locator(`span:has-text("${text}")`).first();
            if (await tabEl.isVisible({ timeout: 1000 })) {
              await tabEl.click();
              clickedTab = true;
              console.log(`[用户${tabLabel}同步] 通过文字 "${text}" 点击了喜欢 tab`);
              break;
            }
          } catch (e) { }
        }
      }

      if (!clickedTab) {
        console.log(`[用户${tabLabel}同步] ⚠️ 未能点击喜欢 tab，尝试直接导航`);
        try {
          await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (err) {
          console.log(`[用户${tabLabel}同步] 导航可能超时，忽略继续: ${err.message}`);
        }
      }

      await page.waitForTimeout(1500);
      
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
};
