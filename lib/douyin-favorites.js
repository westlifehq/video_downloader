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
      chromium = require('playwright').chromium;
    } catch (err) {
      throw new Error('Playwright 未安装。请运行: npm install playwright && npx playwright install chromium');
    }
  }
  return chromium;
}

// 路径配置
const isPkg = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? path.dirname(process.execPath) : process.cwd();
const USER_DATA_DIR = path.join(BASE_DIR, 'user_data');
const SYNCED_IDS_PATH = path.join(BASE_DIR, 'synced_ids.json');

// 全局浏览器引用（防止重复启动）
let activeBrowser = null;
let loginResolve = null;

/**
 * 检查登录状态
 */
function checkLoginStatus() {
  const hasUserData = fs.existsSync(USER_DATA_DIR) &&
    fs.readdirSync(USER_DATA_DIR).length > 0;

  const syncData = getSyncedData();

  return {
    loggedIn: hasUserData,
    lastSyncTime: syncData.lastSyncTime || null,
    syncedCount: syncData.ids ? syncData.ids.length : 0,
  };
}

/**
 * 打开浏览器窗口让用户扫码登录
 */
async function openLoginBrowser() {
  if (activeBrowser) {
    throw new Error('已有一个浏览器窗口在运行，请先完成当前操作');
  }

  const pw = getChromium();

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  let context;
  try {
    context = await pw.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      // 优先尝试使用用户本地已安装的 Chrome，提高 .exe 的开箱即用率
      channel: 'chrome',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    });
    activeBrowser = context;
  } catch (err) {
    console.error('[收藏同步] 浏览器启动失败:', err.message);
    if (err.message.includes('Executable doesn\'t exist') || err.message.includes('find browser')) {
      // 如果 Chrome 也没找到，尝试不带 channel（使用 playwright 默认自带的）再试一次，还是不行就报详细错
      try {
        context = await pw.launchPersistentContext(USER_DATA_DIR, {
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
          ],
          viewport: { width: 1280, height: 800 },
          locale: 'zh-CN',
        });
        activeBrowser = context;
      } catch (err2) {
        throw new Error('未检测到 Chromium 或 Chrome 浏览器！请在本机安装 Chrome 浏览器，或通过终端运行 "npx playwright install chromium" 补充环境。');
      }
    } else {
      throw err;
    }
  }

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });

  console.log('[收藏同步] 请在浏览器中扫码登录...');

  return new Promise((resolve, reject) => {
    let checkInterval;
    let timeoutTimer;

    loginResolve = resolve;

    checkInterval = setInterval(async () => {
      try {
        const isLoggedIn = await page.evaluate(() => {
          const avatar = document.querySelector('[data-e2e="user-avatar"]') ||
            document.querySelector('.avatar-wrapper') ||
            document.querySelector('[class*="avatar"]');
          const hasCookie = document.cookie.includes('sessionid') &&
            !document.cookie.includes('sessionid=;');
          return !!(avatar || hasCookie);
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
          if (checkLoginStatus().loggedIn) {
            resolve({ success: true });
          } else {
            reject(new Error('浏览器已关闭，登录未完成'));
          }
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
 * 通过拦截浏览器的 API 响应来获取数据
 * 
 * @param {number} maxCount - 最多获取的视频数量
 * @param {function} onProgress - 进度回调
 * @param {function} checkInterrupt - 检查是否应该打断
 * @returns {Promise<Array>} 收藏的视频信息列表
 */
async function fetchFavorites(maxCount = 50, onProgress = null, checkInterrupt = null) {
  if (activeBrowser) {
    throw new Error('已有一个浏览器窗口在运行，请先完成当前操作');
  }

  if (!checkLoginStatus().loggedIn) {
    throw new Error('未登录，请先扫码登录');
  }

  const pw = getChromium();

  console.log(`[收藏同步] 启动浏览器，目标获取 ${maxCount} 条收藏...`);


  let context;
  try {
    context = await pw.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      channel: 'chrome', // 尽量复用本机 Chrome
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
      ],
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    });
  } catch (err) {
    // 同理，如果指定 chrome 失败，尝试默认模式
    try {
      context = await pw.launchPersistentContext(USER_DATA_DIR, {
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
        ],
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
      });
    } catch (err2) {
      throw new Error('同步页面启动失败。请确保本机已安装 Chrome 浏览器。');
    }
  }

  activeBrowser = context;

  try {
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // 收集到的视频列表
    const collected = [];
    const seenIds = new Set();
    let hasMore = true;
    let apiHitCount = 0;

    // ═══════════════════════════════════════════
    // 关键修复：使用宽泛的 URL 匹配 + 日志调试
    // ═══════════════════════════════════════════
    
    // 匹配抖音所有可能的收藏/喜欢 API 路径
    const FAV_API_PATTERNS = [
      'aweme/v1/web/aweme/favorite',    // 收藏视频 v1
      'aweme/v2/web/aweme/favorite',    // 收藏视频 v2
      'aweme/v1/web/aweme/listcollection', // 收藏夹
      'aweme/v2/web/aweme/listcollection',
      'web/api/favorite',               // 新版 API
      '/favorite/',                      // 通用 fallback
      'aweme_list',                      // 响应体中常见字段
    ];

    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();

      // 记录所有抖音域名下的 API 请求（用于调试）
      if (url.includes('douyin.com') && url.includes('/aweme/')) {
        console.log(`[收藏同步][API] ${status} ${url.substring(0, 150)}`);
      }

      // 宽泛匹配：任何包含 favorite 或 collection 的 API
      const isFavApi = url.includes('favorite') || url.includes('collection');
      if (!isFavApi) return;

      // 过滤非 JSON 响应
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json') && !contentType.includes('text')) return;

      try {
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return; // 非 JSON 响应
        }

        // 查找视频列表 — 支持多种数据结构
        let awemeList = json.aweme_list || [];
        
        // 某些接口把数据放在 data.aweme_list 下
        if (awemeList.length === 0 && json.data && json.data.aweme_list) {
          awemeList = json.data.aweme_list;
        }
        
        // 某些接口用 collects_list 或 items
        if (awemeList.length === 0 && json.collects_list) {
          awemeList = json.collects_list;
        }
        if (awemeList.length === 0 && json.data && json.data.collects_list) {
          awemeList = json.data.collects_list;
        }

        if (awemeList.length === 0) {
          console.log(`[收藏同步][API] 命中 URL 但无 aweme_list: ${url.substring(0, 120)}`);
          console.log(`[收藏同步][API] 响应 keys: ${Object.keys(json).join(', ')}`);
          if (json.data) {
            console.log(`[收藏同步][API] data keys: ${Object.keys(json.data).join(', ')}`);
          }
          return;
        }

        apiHitCount++;
        console.log(`[收藏同步] ✅ 拦截到 API 响应 #${apiHitCount}，包含 ${awemeList.length} 条视频`);

        for (const item of awemeList) {
          if (collected.length >= maxCount) break;

          const awemeId = item.aweme_id || '';
          // 去重（同一个视频可能出现在多次 API 响应中）
          if (seenIds.has(awemeId)) continue;
          seenIds.add(awemeId);

          collected.push(item);

          if (onProgress) {
            onProgress(collected.length, maxCount, {
              awemeId,
              title: item.desc || '未知标题',
            });
          }
        }

        if (json.has_more === false || json.has_more === 0) {
          hasMore = false;
        }
      } catch (err) {
        console.log(`[收藏同步] 解析 API 响应失败: ${err.message}`);
      }
    });

    // ═══════════════════════════════════════════
    // 导航策略：先去主页，检查登录，再切到收藏 tab
    // ═══════════════════════════════════════════
    console.log('[收藏同步] 打开个人主页...');
    await page.goto('https://www.douyin.com/user/self', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(3000);

    // 检查是否重定向到登录页
    const currentUrl = page.url();
    console.log(`[收藏同步] 当前 URL: ${currentUrl}`);
    if (currentUrl.includes('login') || currentUrl.includes('passport')) {
      throw new Error('登录态已失效，请重新扫码登录');
    }

    // 等待页面内容加载
    await page.waitForTimeout(2000);

    // 尝试点击「收藏」tab
    console.log('[收藏同步] 尝试点击收藏 tab...');
    let clickedTab = false;
    
    // 策略1：通过 data-e2e 属性
    const selectors = [
      '[data-e2e="user-tab-favorite"]',
      '[data-e2e="user-tab-collection"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        clickedTab = true;
        console.log(`[收藏同步] 通过选择器 ${sel} 点击了收藏 tab`);
        break;
      }
    }

    // 策略2：通过文字匹配
    if (!clickedTab) {
      const tabTexts = ['收藏', '喜欢'];
      for (const text of tabTexts) {
        try {
          const tabEl = await page.locator(`span:has-text("${text}")`).first();
          if (await tabEl.isVisible()) {
            await tabEl.click();
            clickedTab = true;
            console.log(`[收藏同步] 通过文字 "${text}" 点击了 tab`);
            break;
          }
        } catch (e) {
          // 继续尝试下一个
        }
      }
    }

    if (!clickedTab) {
      console.log('[收藏同步] ⚠️ 未能点击收藏 tab，尝试直接导航到收藏页');
      await page.goto('https://www.douyin.com/user/self?showTab=like', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
    }

    // 等待 API 响应
    await page.waitForTimeout(4000);

    // 打印当前页面标题和 URL
    console.log(`[收藏同步] 页面标题: ${await page.title()}`);
    console.log(`[收藏同步] 已收集 ${collected.length} 条，开始滚动...`);

    // 滚动加载更多
    let scrollAttempts = 0;
    const maxScrollAttempts = 20;
    let lastCollectedCount = 0;
    let staleScrolls = 0;

    while (collected.length < maxCount && hasMore && scrollAttempts < maxScrollAttempts) {
      if (checkInterrupt && checkInterrupt()) {
        console.log('[收藏同步] 接到打断信号，停止滚动轮询。');
        break;
      }
      scrollAttempts++;

      await page.evaluate(() => window.scrollBy(0, 800));
      
      const delay = 2000 + Math.random() * 1500;
      await page.waitForTimeout(delay);

      console.log(`[收藏同步] 滚动 #${scrollAttempts}，已收集 ${collected.length}/${maxCount}`);

      // 如果连续 5 次滚动没有新数据，停止
      if (collected.length === lastCollectedCount) {
        staleScrolls++;
        if (staleScrolls >= 5) {
          console.log('[收藏同步] 连续 5 次滚动无新数据，停止');
          break;
        }
      } else {
        staleScrolls = 0;
        lastCollectedCount = collected.length;
      }
    }

    console.log(`[收藏同步] 收集完成，共 ${collected.length} 条视频，API 命中 ${apiHitCount} 次`);

    return collected;
  } finally {
    try { await context.close(); } catch (e) { }
    activeBrowser = null;
  }
}

/**
 * 退出登录（清除 user_data 目录）
 */
function logout() {
  if (activeBrowser) {
    throw new Error('浏览器正在运行中，请等待操作完成后再退出');
  }

  if (fs.existsSync(USER_DATA_DIR)) {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    console.log('[收藏同步] 已清除登录数据');
  }

  return { success: true };
}

/**
 * 读取同步记录
 */
function getSyncedData() {
  try {
    return JSON.parse(fs.readFileSync(SYNCED_IDS_PATH, 'utf-8'));
  } catch {
    return { lastSyncTime: null, ids: [] };
  }
}

/**
 * 保存同步记录
 */
function saveSyncedIds(newIds) {
  const data = getSyncedData();
  const existingSet = new Set(data.ids || []);

  for (const id of newIds) {
    existingSet.add(id);
  }

  const updated = {
    lastSyncTime: new Date().toISOString(),
    ids: Array.from(existingSet),
  };

  fs.writeFileSync(SYNCED_IDS_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

module.exports = {
  checkLoginStatus,
  openLoginBrowser,
  fetchFavorites,
  logout,
  getSyncedData,
  saveSyncedIds,
};
