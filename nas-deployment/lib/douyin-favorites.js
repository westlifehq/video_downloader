/**
 * 抖音收藏同步模块
 * 
 * 使用 Playwright 浏览器自动化 + API 响应拦截方案。
 * 不需要逆向 X-Bogus 签名，让浏览器自己计算签名，我们只拦截响应数据。
 */

const path = require('path');
const fs = require('fs');

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
function checkLoginStatus() {
  // 只有存在手动注入的 cookie 文件才算"已登录"
  const hasCookie = fs.existsSync(COOKIE_PATH);
  let sessionId = null;
  if (hasCookie) {
    try {
      const data = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
      sessionId = data.sessionid;
    } catch(e) {}
  }

  const syncData = getSyncedData();

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

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  let context;
  const isDocker = fs.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
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

  const publicPath = path.join(BASE_DIR, 'public');
  const screenshotPath = path.join(publicPath, 'login_debug.png');
  const saveDebugShot = async (name = '') => {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[收藏同步] 诊断截图已保存 (${name})`);
    } catch (e) { }
  };

  await saveDebugShot('开始加载');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

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
            await page.waitForTimeout(3000);
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
  await page.waitForTimeout(3000);

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
          await page.waitForTimeout(2000);
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
          if (checkLoginStatus().loggedIn) resolve({ success: true });
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

  if (!checkLoginStatus().loggedIn) {
    throw new Error('未登录，请先扫码登录');
  }

  const tabLabel = tabType === 'like' ? '喜欢同步' : '收藏同步';
  const pw = getChromium();
  const isDocker = fs.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
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
    if (fs.existsSync(COOKIE_PATH)) {
      try {
        const cookieData = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
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
    await page.waitForTimeout(5000);

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

    await page.waitForTimeout(4000);
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
      await page.waitForTimeout(2000 + Math.random() * 1500);
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

  if (fs.existsSync(USER_DATA_DIR)) {
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch (err) {
      try { require('child_process').execSync(`rm -rf "${USER_DATA_DIR}"`); } catch (err2) { }
    }
  }
  // 删掉持久化的 cookie 文件
  if (fs.existsSync(COOKIE_PATH)) {
    try { fs.unlinkSync(COOKIE_PATH); } catch(e) {}
  }
  return { success: true };
}

function getSyncedData() {
  try { return JSON.parse(fs.readFileSync(SYNCED_IDS_PATH, 'utf-8')); } catch { return { lastSyncTime: null, ids: [] }; }
}

function saveSyncedIds(newIds) {
  const data = getSyncedData();
  const existingSet = new Set(data.ids || []);
  for (const id of newIds) existingSet.add(id);
  const updated = { lastSyncTime: new Date().toISOString(), ids: Array.from(existingSet) };
  fs.writeFileSync(SYNCED_IDS_PATH, JSON.stringify(updated, null, 2));
  return updated;
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
    const match = cleanCookie.match(/sessionid=([^;]+)/);
    if (match) sessionValue = match[1];
  }

  // 基本格式校验：sessionid 应为 32 位以上的字母数字串
  if (!/^[a-zA-Z0-9]{16,}$/.test(sessionValue)) {
    throw new Error('sessionid 格式不正确，应为一串字母数字（通常 32 位以上）');
  }

  // 确保 user_data 目录存在
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  // 持久化到本地文件，供 fetchFavorites 使用
  fs.writeFileSync(COOKIE_PATH, JSON.stringify({ sessionid: sessionValue, updatedAt: new Date().toISOString() }, null, 2));

  console.log(`[收藏同步] Cookie 注入成功，已持久化到文件 (sessionid=${sessionValue.substring(0, 8)}...)`);
  return { success: true };
}

/**
 * 获取喜欢的视频列表（复用 fetchFavorites 内部逻辑，切换到"喜欢"tab）
 */
async function fetchLikedVideos(maxCount = 50, onProgress = null, checkInterrupt = null) {
  return fetchFavorites(maxCount, onProgress, checkInterrupt, 'like');
}

function getLikedData() {
  try { return JSON.parse(fs.readFileSync(LIKED_IDS_PATH, 'utf-8')); } catch { return { lastSyncTime: null, ids: [] }; }
}

function saveLikedIds(newIds) {
  const data = getLikedData();
  const existingSet = new Set(data.ids || []);
  for (const id of newIds) existingSet.add(id);
  const updated = { lastSyncTime: new Date().toISOString(), ids: Array.from(existingSet) };
  fs.writeFileSync(LIKED_IDS_PATH, JSON.stringify(updated, null, 2));
  return updated;
}


// ═══════════════════════════════════════════
// 私信视频提取
// ═══════════════════════════════════════════

async function fetchMessageVideos(maxCount = 50, onProgress, checkInterrupt) {
    const chromiumInstance = getChromium();

    const loggedIn = checkLoginStatus();
    if (!loggedIn || !loggedIn.loggedIn) {
        throw new Error('未登录或 Cookie 已失效，请先绑定凭证');
    }

    const isDocker = fs.existsSync('/.dockerenv') || process.env.IS_DOCKER === 'true';
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

    // 注入 Cookie
    if (fs.existsSync(COOKIE_PATH)) {
        try {
            const cookieData = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
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

        await page.waitForTimeout(5000);

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
                await page.waitForTimeout(3000);

                // 在消息区域滚动加载更多历史消息
                const messageArea = await page.$('[class*="MessageList"], [class*="messageList"]');
                if (messageArea) {
                    for (let scroll = 0; scroll < 3; scroll++) {
                        if (collectedItems.length >= maxCount) break;
                        if (checkInterrupt && checkInterrupt()) break;
                        await messageArea.evaluate(el => { el.scrollTop = 0; });
                        await page.waitForTimeout(2000);
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
    } finally {
        try { await context.close(); } catch (e) { }
    }

    // 解析每个提取到的引用为完整视频信息
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
                videoInfo = await douyinLib.fetchVideoInfo(ref._refValue);
            } else if (ref._refType === 'share_url') {
                const resolved = await douyinLib.resolveShareUrl(ref._refValue);
                if (resolved) {
                    const vid = douyinLib.extractVideoId(resolved);
                    if (vid) videoInfo = await douyinLib.fetchVideoInfo(vid);
                }
            }

            if (videoInfo) {
                resolvedItems.push(videoInfo);
            }
        } catch (err) {
            console.error('[私信同步] 解析视频引用失败 [' + ref._refType + ': ' + ref._refValue + ']:', err.message);
        }

        // 避免请求过快触发风控
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('[私信同步] 完成，共解析 ' + resolvedItems.length + ' 个视频');
    return resolvedItems;
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
};
