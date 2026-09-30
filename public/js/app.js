/* ═══════════════════════════════════════════
   抖音视频下载器 — 核心事件绑定与业务流程控制器
   ═══════════════════════════════════════════ */

// ── 模块级全局状态 ──
let favSyncPollTimer = null;
let favIsLoggedIn = false;
let favLoginPollTimer = null;
let favSyncedItems = [];
let favDownloadStates = {};
let isFavMultiSelectMode = false;
let favSelectedItems = new Set();

let likedSyncPollTimer = null;
let likedSyncedItems = [];
let likedDownloadStates = {};
let isLikedMultiSelectMode = false;
let likedSelectedItems = new Set();

let msgSyncPollTimer = null;
let msgSyncedItems = [];
let msgDownloadStates = {};
let isMsgMultiSelectMode = false;
let msgSelectedItems = new Set();

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    loadApiTokenSetting();
    loadHistory();
    loadFavStatus();
    loadLikedStatus();
    loadMsgStatus();
    loadScheduleConfig();

    const urlInput = document.getElementById('urlInput');
    if (urlInput) {
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) {
                e.preventDefault();
                handleParse();
            }
        });

        urlInput.addEventListener('paste', () => {
            setTimeout(() => handleParse(), 100);
        });
    }
});

// ── Tab 切换 ──
function switchSyncTab(tab) {
    document.querySelectorAll('.sync-tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sync-tab-content').forEach(el => el.classList.remove('active'));
    
    const tabEl = document.querySelector(`.sync-tab[data-tab="${tab}"]`);
    if (tabEl) tabEl.classList.add('active');
    
    const tabMap = { fav: 'tabFav', liked: 'tabLiked', messages: 'tabMessages', schedule: 'tabSchedule', auth: 'tabAuth' };
    const contentEl = document.getElementById(tabMap[tab]);
    if (contentEl) contentEl.classList.add('active');
}

// ── UI 交互逻辑 ──
function handleInputResize(el) {
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight) + 'px';
    const clearBtn = document.getElementById('clearBtn');
    if (el.value.trim() !== '') {
        clearBtn.style.display = 'flex';
    } else {
        clearBtn.style.display = 'none';
        el.style.height = 'auto'; // 收起
    }
}

function clearInput() {
    const el = document.getElementById('urlInput');
    if (el) {
        el.value = '';
        handleInputResize(el);
        el.focus();
    }
}

// ── 配置 ──
async function loadConfig() {
    try {
        const config = await api('GET', '/api/config');
        const dirInput = document.getElementById('downloadDir');
        if (dirInput) {
            dirInput.value = config.downloadDir || '';
            dirInput.dispatchEvent(new Event('input'));
        }
    } catch (err) {
        console.error('加载配置失败:', err);
    }
}

async function saveConfig() {
    const downloadDir = document.getElementById('downloadDir').value.trim();
    if (!downloadDir) {
        showToast('请输入下载目录路径', 'error');
        return;
    }

    try {
        await api('POST', '/api/config', { downloadDir });
        showToast('设置已保存', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function loadApiTokenSetting() {
    const input = document.getElementById('apiTokenInput');
    if (input) {
        input.value = getApiToken();
    }
}

function saveApiTokenSetting() {
    const input = document.getElementById('apiTokenInput');
    if (!input) return;

    const token = input.value.trim();
    if (!token) {
        showToast('请输入 API Token', 'error');
        return;
    }

    setApiToken(token);
    input.value = token;
    showToast('API Token 已保存', 'success');
}

function clearApiTokenSetting() {
    const input = document.getElementById('apiTokenInput');
    setApiToken('');
    if (input) {
        input.value = '';
    }
    showToast('API Token 已清除', 'success');
}

// ── 解析逻辑 ──
async function handleParse() {
    const input = document.getElementById('urlInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) {
        showError('请输入抖音视频或图文链接');
        return;
    }

    const urls = text.match(/https?:\/\/[^\s]+/g);
    if (!urls || urls.length === 0) {
        showError('未在输入中提取到有效网址');
        return;
    }

    const btn = document.getElementById('parseBtn');
    setLoading(btn, true);
    hideError();

    const container = document.getElementById('resultsContainer');
    if (container) container.innerHTML = '';

    // 取消所有进行中的轮询
    Object.values(appState.pollTimers).forEach(clearInterval);
    appState.items = {};
    appState.pollTimers = {};

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const id = 'task_' + Date.now() + '_' + i;
        appState.items[id] = { id, url, loading: true };
        appendCardPlaceHolder(id);
    }

    // 平滑滚动到解析区域，展示“解析中...”动画
    if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });

    urls.forEach((url, i) => {
        const id = Object.keys(appState.items)[i];
        api('POST', '/api/parse', { url })
            .then(res => {
                appState.items[id] = { ...appState.items[id], loading: false, info: res.data };
                updateCard(id);
            })
            .catch(err => {
                appState.items[id] = { ...appState.items[id], loading: false, error: err.message };
                updateCard(id);
            });
    });

    setLoading(btn, false);
}

// ── 下载与轮询处理 ──
async function handleDownload(id) {
    const item = appState.items[id];
    if (!item || !item.info) return;

    item.status = 'downloading';
    item.progress = 0;
    updateCard(id);

    try {
        const payload = {
            type: item.info.type,
            videoUrl: item.info.videoUrl,
            images: item.info.images,
            livePhotos: item.info.livePhotos,
            cover: item.info.cover,
            title: item.info.title,
            awemeId: item.info.awemeId,
            platform: item.info.platform || 'douyin',
        };

        const result = await api('POST', '/api/download', payload);
        item.taskId = result.taskId;
        updateCard(id);
        startPolling(id);
    } catch (err) {
        item.status = 'error';
        item.downloadError = err.message;
        updateCard(id);
    }
}

function clearPollTimer(timerKey) {
    if (!appState.pollTimers[timerKey]) return;
    clearInterval(appState.pollTimers[timerKey]);
    delete appState.pollTimers[timerKey];
}

function startPolling(id) {
    const item = appState.items[id];
    clearPollTimer(id);

    let pollRetry = 0;
    appState.pollTimers[id] = setInterval(async () => {
        if (!item.taskId) return;
        try {
            const task = await api('GET', `/api/download/${item.taskId}`);
            pollRetry = 0;
            item.progress = task.progress || 0;
            item.downloaded = task.downloaded || 0;
            item.total = task.total || 0;

            if (task.status === 'done') {
                clearPollTimer(id);
                item.status = 'done';
                item.fileSize = task.fileSize;
                item.fileName = task.fileName;
                item.filePath = task.filePath;
                updateCard(id);
                onDownloadComplete(item);
            } else if (task.status === 'error') {
                clearPollTimer(id);
                item.status = 'error';
                item.downloadError = task.error;
                updateCard(id);
                showToast('下载失败: ' + (task.error || '未知错误'), 'error');
            } else {
                updateCard(id);
            }
        } catch (err) {
            pollRetry += 1;
            if (pollRetry >= 60) {
                clearPollTimer(id);
                item.status = 'error';
                item.downloadError = '下载轮询超时，请检查网络';
                updateCard(id);
                showToast(item.downloadError, 'error');
            }
        }
    }, 500);
}

function onDownloadComplete(item) {
    showToast(`${item.info.type === 'image' ? '图文' : '视频'}下载完成！`, 'success');
    loadHistory();
}

// ── 历史记录 ──
async function fetchHistory() {
    const history = await api('GET', '/api/history');
    return Array.isArray(history) ? history : [];
}

async function loadHistory() {
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    const filtersEl = document.getElementById('historyFilters');

    if (!section || !list) return;

    let history = [];
    try {
        history = await fetchHistory();
    } catch (err) {
        section.style.display = 'none';
        showToast('加载历史失败: ' + err.message, 'error');
        return;
    }

    if (history.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    if (filtersEl) filtersEl.style.display = history.length > 3 ? 'flex' : 'none';

    // Populate author filter
    const authorSelect = document.getElementById('historyFilterAuthor');
    if (authorSelect) {
        const currentAuthorVal = authorSelect.value;
        const authors = [...new Set(history.map(h => h.author).filter(Boolean))];
        authorSelect.innerHTML = '<option value="">全部作者</option>' + authors.map(a => `<option value="${escapeHTML(a)}"${a === currentAuthorVal ? ' selected' : ''}>@${escapeHTML(a)}</option>`).join('');
    }

    // Apply filters
    const keywordInput = document.getElementById('historyFilterKeyword');
    const keyword = keywordInput ? (keywordInput.value || '').trim().toLowerCase() : '';
    const authorSelectEl = document.getElementById('historyFilterAuthor');
    const authorFilter = authorSelectEl ? authorSelectEl.value : '';
    const dateSelectEl = document.getElementById('historyFilterDate');
    const dateFilter = dateSelectEl ? dateSelectEl.value : '';

    const now = Date.now();
    const filtered = history.filter(item => {
        if (keyword && !(item.title || '').toLowerCase().includes(keyword) && !(item.author || '').toLowerCase().includes(keyword)) return false;
        if (authorFilter && item.author !== authorFilter) return false;
        if (dateFilter === 'today' && (now - item.time) > 86400000) return false;
        if (dateFilter === 'week' && (now - item.time) > 7 * 86400000) return false;
        if (dateFilter === 'month' && (now - item.time) > 30 * 86400000) return false;
        return true;
    });

    if (filtered.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--c-text-muted);font-size:13px;">无匹配记录</div>';
        return;
    }

    list.innerHTML = filtered.map((item, index) => {
        const realIndex = history.indexOf(item);
        const placeholderHtml = `<div class="history-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`;
        const thumbHtml = item.cover
            ? `<img class="history-thumb" src="${escapeHTML(item.cover)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">` + `<div class="history-thumb-placeholder" style="display:none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`
            : placeholderHtml;
        const authorStr = item.author ? `<span style="font-size:11px;color:var(--c-text-muted);">@${escapeHTML(item.author)}</span>` : '';
        const timeStr = item.time ? `<span style="font-size:11px;color:var(--c-text-muted);">${new Date(item.time).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>` : '';
        const safePathId = registerPath(item.filePath);
        return `
      <div class="history-item">
        ${thumbHtml}
        <div class="history-info">
          <span class="history-name" title="${escapeHTML(item.filePath || '')}">${escapeHTML(item.title || item.fileName)}</span>
          <div class="history-meta">
            ${authorStr}
            ${timeStr}
            <span class="history-status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>Completed</span>
            <span class="history-size">${formatBytes(item.fileSize)}</span>
          </div>
        </div>
        <div class="history-actions">
          <button class="action-btn action-btn--open" onclick="openHistoryFileById('${safePathId}')" title="在文件夹中显示">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="action-btn action-btn--delete" onclick="deleteHistoryFileById('${safePathId}', ${realIndex})" title="从磁盘删除文件">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
    }).join('');
}

function applyHistoryFilter() {
    loadHistory();
}

async function openHistoryFile(filePath) {
    if (!filePath) return;
    try {
        await api('POST', '/api/history/open', { filePath });
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已不存在，可能已被手动删除', 'error');
        } else {
            showToast('无法打开文件: ' + err.message, 'error');
        }
    }
}

async function deleteHistoryFile(filePath) {
    if (!confirm('确定要从本地磁盘删除这个文件吗？此操作不可撤销。')) return;

    try {
        await api('POST', '/api/history/delete', { filePath });
        showToast('文件已删除', 'success');
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已经不存在了', 'info');
        } else {
            showToast('删除失败: ' + err.message, 'error');
        }
    } finally {
        loadHistory();
    }
}

async function clearHistory() {
    const history = await fetchHistory().catch(() => []);
    if (!history.length) {
        showToast('历史记录已清空', 'success');
        return;
    }

    showToast('历史记录由服务端任务状态生成，无法在前端直接清空', 'info');
    loadHistory();
}

// ── 设置面板 ──
function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    const chevron = document.getElementById('settingsChevron');
    if (!panel) return;

    if (panel.style.display === 'none' || panel.style.display === '') {
        panel.style.display = 'block';
        if (chevron) chevron.classList.add('open');
    } else {
        panel.style.display = 'none';
        if (chevron) chevron.classList.remove('open');
    }
}

function openSettingsSection() {
    const panel = document.getElementById('settingsPanel');
    const chevron = document.getElementById('settingsChevron');
    const section = document.getElementById('settingsSection');

    if (panel && (panel.style.display === 'none' || panel.style.display === '')) {
        panel.style.display = 'block';
        if (chevron) chevron.classList.add('open');
    }

    if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// ═══════════════════════════════════════════
// 收藏同步
// ═══════════════════════════════════════════
async function stopFavSync(taskId) {
    if(!confirm('确定要打断当前同步并结算已抓取的数据吗？')) return;
    try {
        await api('POST', '/api/favorites/sync/stop', { taskId });
        showToast('已发送打断信号，请稍候...', 'info');
    } catch (err) {
        showToast('打断失败: ' + err.message, 'error');
    }
}

async function loadFavStatus() {
    try {
        const status = await api('GET', '/api/favorites/status');
        favIsLoggedIn = status.loggedIn;
        updateFavUI(status);
        updateLikedUI(status);
    } catch (err) {
        console.error('加载收藏状态失败:', err);
    }
}

function updateFavUI(status) {
    const badge = document.getElementById('syncBadge');
    const accountBtnText = document.getElementById('favAccountBtnText');
    const accountBtn = document.getElementById('syncAccountBtn');
    const syncBtn = document.getElementById('favSyncBtn');

    if (!syncBtn) return;

    if (status.loggedIn) {
        if (badge) {
            badge.style.display = 'inline-flex';
            const badgeText = document.getElementById('syncBadgeText');
            if (badgeText) badgeText.textContent = status.lastSyncTime ? `同步 ${formatSyncTime(status.lastSyncTime)}` : '已登录';
        }
        if (accountBtnText) accountBtnText.textContent = '切换账号';
        if (accountBtn) setBtnText(accountBtn, '已登录');
        syncBtn.disabled = false;
    } else {
        if (badge) badge.style.display = 'none';
        if (accountBtnText) accountBtnText.textContent = '登录';
        if (accountBtn) setBtnText(accountBtn, '登录');
        syncBtn.disabled = true;
    }
}

async function handleFavAccount() {
    if (favIsLoggedIn) {
        if (!confirm('确认退出当前抖音账号？')) return;
        try {
            await api('POST', '/api/favorites/logout');
            showToast('已退出当前账号', 'success');
            favIsLoggedIn = false;
            updateFavUI({ loggedIn: false });
            updateLikedUI({ loggedIn: false });
            switchSyncTab('auth');
            favSyncedItems = [];
        } catch (err) {
            showToast('退出失败: ' + err.message, 'error');
        }
    } else {
        switchSyncTab('auth');
        setTimeout(() => {
            const input = document.getElementById('cookieInput');
            if (input) input.focus();
        }, 100);
    }
}

async function handleCookieSubmit() {
    const input = document.getElementById('cookieInput');
    if (!input) return;
    const cookieVal = input.value.trim();
    const btn = document.getElementById('cookieSubmitBtn');
    
    if (!cookieVal) {
        showToast('请先输入 Cookie 值', 'warning');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '绑定中...';
    }

    try {
        await api('POST', '/api/favorites/cookie-login', { cookie: cookieVal });
        input.value = '';
        showToast('绑定成功！', 'success');
        await loadFavStatus();
        switchSyncTab('fav');
    } catch (err) {
        showToast('绑定失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '绑定凭证';
        }
    }
}

// 兼容新旧按钮结构：优先 .btn-label 子元素，否则直接设置按钮文本
function setBtnText(btn, text) {
    if (!btn) return;
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = text;
    else btn.textContent = text;
}

async function handleFavoritesSync() {
    const syncBtn = document.getElementById('favSyncBtn');
    if (!syncBtn) return;
    const maxCount = parseInt(document.getElementById('favMaxCount').value) || 50;
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        setBtnText(syncBtn, '同步中 . . .');

        const result = await api('POST', '/api/favorites/sync', { maxCount });
        if (result.taskId) {
            pollFavSync(result.taskId);
        }
    } catch (err) {
        if (err.message.includes('已有同步任务')) {
            showToast('已有同步任务在进行中', 'error');
        } else if (err.message.includes('未登录') || err.message.includes('失效')) {
            showToast('登录态已失效，请重新登录', 'error');
            favIsLoggedIn = false;
            updateFavUI({ loggedIn: false });
        } else {
            showToast('同步失败: ' + err.message, 'error');
        }
        syncBtn.classList.remove('syncing');
        syncBtn.disabled = false;
        setBtnText(syncBtn, '同步收藏');
    }
}

function pollFavSync(taskId) {
    const panel = document.getElementById('favSyncPanel');
    if (!panel) return;
    panel.style.display = 'block';

    if (favSyncPollTimer) clearInterval(favSyncPollTimer);

    favSyncPollTimer = setInterval(async () => {
        try {
            const task = await api('GET', `/api/favorites/sync/${taskId}`);

            if (task.status === 'fetching') {
                panel.innerHTML = `
                    <div class="fav-sync-header">
                        <div>
                            <span class="fav-sync-phase">${escapeHTML(task.phase || '正在获取收藏列表...')}</span>
                            <span class="fav-sync-counter" style="margin-left:8px">已发现 ${task.collected || 0} 条</span>
                        </div>
                        <button class="btn btn--stop" style="padding:4px 10px;font-size:11px;border-radius:6px;color:var(--c-error);border:none;cursor:pointer;" onclick="stopFavSync('${taskId}')">停止打断</button>
                    </div>
                    <div class="fav-sync-progress">
                        <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                    </div>
                `;
            } else if (task.status === 'done' || task.status === 'error') {
                clearInterval(favSyncPollTimer);
                favSyncPollTimer = null;

                const syncBtn = document.getElementById('favSyncBtn');
                if (syncBtn) {
                    syncBtn.classList.remove('syncing');
                    syncBtn.disabled = false;
                    setBtnText(syncBtn, '同步收藏');
                }
                loadFavStatus();

                if (task.status === 'error') {
                    panel.innerHTML = `<div class="fav-login-hint" style="color:var(--c-error)">同步失败：${escapeHTML(task.error || '获取失败')}</div>`;
                    showToast('获取收藏列表失败', 'error');
                } else {
                    favSyncedItems = task.items || [];
                    favDownloadStates = {};
                    renderFavList();
                    const newCount = favSyncedItems.filter(i => !i.alreadyDownloaded && !i.parseError).length;
                    showToast(`已获取 ${task.items.length} 条收藏，${newCount} 条未下载`, 'success');
                }
            }
        } catch (err) {
            console.error('轮询同步进度失败:', err);
        }
    }, 1000);
}

async function downloadFavItem(idx) {
    const item = favSyncedItems[idx];
    if (!item) return;

    const awemeId = item.awemeId;
    if (favDownloadStates[awemeId] && favDownloadStates[awemeId].status === 'downloading') return;

    item.alreadyDownloaded = false;
    favDownloadStates[awemeId] = { status: 'downloading', progress: 0 };
    renderFavList();

    try {
        const result = await api('POST', '/api/download', {
            type: item.type,
            videoUrl: item.videoUrl,
            images: item.images,
            livePhotos: item.livePhotos,
            cover: item.cover,
            title: item.title,
            awemeId: item.awemeId,
            platform: item.platform || 'douyin',
        });
        if (!result.taskId) throw new Error('No taskId');

        let favPollRetry = 0;
        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                favPollRetry = 0;
                favDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    favDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    item.alreadyDownloaded = true;
                    renderFavList();
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    favDownloadStates[awemeId].status = 'error';
                    renderFavList();
                    showToast(`下载失败: ${escapeHTML(task.error || '未知错误')}`, 'error');
                } else {
                    renderFavList();
                }
            } catch (e) {
                favPollRetry++;
                if (favPollRetry >= 60) {
                    clearInterval(pollId);
                    favDownloadStates[awemeId].status = 'error';
                    renderFavList();
                    showToast('下载轮询超时，请检查网络', 'error');
                }
            }
        }, 500);
    } catch (err) {
        favDownloadStates[awemeId].status = 'error';
        renderFavList();
        showToast('下载请求失败: ' + err.message, 'error');
    }
}

async function redownloadFavItem(idx) {
    const item = favSyncedItems[idx];
    if (!item) return;
    item.alreadyDownloaded = false;
    delete favDownloadStates[item.awemeId];
    await downloadFavItem(idx);
}

async function openFavFile(idx) {
    const item = favSyncedItems[idx];
    if (!item) return;
    const ds = favDownloadStates[item.awemeId];
    const fp = (ds && ds.filePath) || item.filePath;
    if (fp) {
        await openHistoryFile(fp);
    } else {
        showToast('未找到本地文件路径', 'info');
    }
}

async function deleteFavFile(idx) {
    const item = favSyncedItems[idx];
    if (!item) return;
    const ds = favDownloadStates[item.awemeId];
    const fp = (ds && ds.filePath) || item.filePath;
    if (!fp) {
        showToast('未找到本地文件路径', 'info');
        return;
    }
    if (!confirm(`确定删除文件？\n${fp}`)) return;
    try {
        await api('POST', '/api/history/delete', { filePath: fp });
        showToast('文件已删除', 'success');
        loadHistory();
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已经不存在了', 'info');
        } else {
            showToast('删除失败: ' + err.message, 'error');
            return;
        }
    }
    item.alreadyDownloaded = false;
    delete favDownloadStates[item.awemeId];
    renderFavList();
}

async function downloadAllFavItems() {
    for (let i = 0; i < favSyncedItems.length; i++) {
        const item = favSyncedItems[i];
        if (item.alreadyDownloaded || item.parseError) continue;
        const ds = favDownloadStates[item.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadFavItem(i);
    }
}

function toggleFavMultiSelectMode() {
    isFavMultiSelectMode = !isFavMultiSelectMode;
    if (!isFavMultiSelectMode) {
        favSelectedItems.clear();
    }
    renderFavList();
}

function toggleFavItemSelection(idx) {
    if (!isFavMultiSelectMode) return;
    if (favSelectedItems.has(idx)) {
        favSelectedItems.delete(idx);
    } else {
        favSelectedItems.add(idx);
    }
    renderFavList();
}

function favSelectAllUndownloaded() {
    favSyncedItems.forEach((item, idx) => {
        const dState = favDownloadStates[item.awemeId];
        const isDone = item.alreadyDownloaded || (dState && dState.status === 'done');
        if (!isDone && !item.parseError) {
            favSelectedItems.add(idx);
        }
    });
    renderFavList();
}

async function downloadSelectedFavItems() {
    if (favSelectedItems.size === 0) return;
    const targets = Array.from(favSelectedItems);
    toggleFavMultiSelectMode();
    
    for (const idx of targets) {
        const item = favSyncedItems[idx];
        if (!item || item.parseError) continue;
        const ds = favDownloadStates[item.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadFavItem(idx);
    }
}

// ═══════════════════════════════════════════
// 喜欢同步
// ═══════════════════════════════════════════
async function stopLikedSync(taskId) {
    if(!confirm('确定要打断当前同步并结算已抓取的数据吗？')) return;
    try {
        await api('POST', '/api/liked/sync/stop', { taskId });
        showToast('已发送打断信号，请稍候...', 'info');
    } catch (err) {
        showToast('打断失败: ' + err.message, 'error');
    }
}

async function loadLikedStatus() {
    try {
        const status = await api('GET', '/api/favorites/status');
        updateLikedUI(status);
    } catch (err) {
        console.error('加载喜欢状态失败:', err);
    }
}

function updateLikedUI(status) {
    const syncBtn = document.getElementById('likedSyncBtn');
    if (syncBtn) {
        syncBtn.disabled = !status.loggedIn;
    }
}

async function handleLikedSync() {
    const syncBtn = document.getElementById('likedSyncBtn');
    if (!syncBtn) return;
    const maxCount = parseInt(document.getElementById('likedMaxCount').value) || 50;
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        setBtnText(syncBtn, '同步中 . . .');

        const result = await api('POST', '/api/liked/sync', { maxCount });
        if (result.taskId) {
            pollLikedSync(result.taskId);
        }
    } catch (err) {
        if (err.message.includes('已有同步任务')) {
            showToast('已有同步任务在进行中', 'error');
        } else if (err.message.includes('未登录') || err.message.includes('失效')) {
            showToast('登录态已失效，请先在上方收藏同步区域登录', 'error');
        } else {
            showToast('同步失败: ' + err.message, 'error');
        }
        syncBtn.classList.remove('syncing');
        syncBtn.disabled = false;
        setBtnText(syncBtn, '同步喜欢');
    }
}

function pollLikedSync(taskId) {
    const panel = document.getElementById('likedSyncPanel');
    if (!panel) return;
    panel.style.display = 'block';

    if (likedSyncPollTimer) clearInterval(likedSyncPollTimer);

    likedSyncPollTimer = setInterval(async () => {
        try {
            const task = await api('GET', `/api/liked/sync/${taskId}`);

            if (task.status === 'fetching') {
                panel.innerHTML = `
                    <div class="fav-sync-header">
                        <div>
                            <span class="fav-sync-phase">${escapeHTML(task.phase || '正在获取喜欢列表...')}</span>
                            <span class="fav-sync-counter" style="margin-left:8px">已发现 ${task.collected || 0} 条</span>
                        </div>
                        <button class="btn btn--stop" style="padding:4px 10px;font-size:11px;border-radius:6px;color:var(--c-error);border:none;cursor:pointer;" onclick="stopLikedSync('${taskId}')">停止打断</button>
                    </div>
                    <div class="fav-sync-progress">
                        <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                    </div>
                `;
            } else if (task.status === 'done' || task.status === 'error') {
                clearInterval(likedSyncPollTimer);
                likedSyncPollTimer = null;

                const syncBtn = document.getElementById('likedSyncBtn');
                if (syncBtn) {
                    syncBtn.classList.remove('syncing');
                    syncBtn.disabled = false;
                    setBtnText(syncBtn, '同步喜欢');
                }
                loadLikedStatus();

                if (task.status === 'error') {
                    panel.innerHTML = `<div class="fav-login-hint" style="color:var(--c-error)">同步失败：${escapeHTML(task.error || '获取失败')}</div>`;
                    showToast('获取喜欢列表失败', 'error');
                } else {
                    likedSyncedItems = task.items || [];
                    likedDownloadStates = {};
                    renderLikedList();
                    const newCount = likedSyncedItems.filter(i => !i.alreadyDownloaded && !i.parseError).length;
                    showToast(`已获取 ${task.items.length} 条喜欢，${newCount} 条未下载`, 'success');
                }
            }
        } catch (err) {
            console.error('轮询喜欢同步进度失败:', err);
        }
    }, 1000);
}

async function downloadLikedItem(idx) {
    const item = likedSyncedItems[idx];
    if (!item) return;

    const awemeId = item.awemeId;
    if (likedDownloadStates[awemeId] && likedDownloadStates[awemeId].status === 'downloading') return;

    item.alreadyDownloaded = false;
    likedDownloadStates[awemeId] = { status: 'downloading', progress: 0 };
    renderLikedList();

    try {
        const result = await api('POST', '/api/download', {
            type: item.type,
            videoUrl: item.videoUrl,
            images: item.images,
            livePhotos: item.livePhotos,
            cover: item.cover,
            title: item.title,
            awemeId: item.awemeId,
            platform: item.platform || 'douyin',
        });
        if (!result.taskId) throw new Error('No taskId');

        let likedPollRetry = 0;
        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                likedPollRetry = 0;
                likedDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    likedDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    item.alreadyDownloaded = true;
                    renderLikedList();
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    likedDownloadStates[awemeId].status = 'error';
                    renderLikedList();
                    showToast(`下载失败: ${escapeHTML(task.error || '未知错误')}`, 'error');
                } else {
                    renderLikedList();
                }
            } catch (e) {
                likedPollRetry++;
                if (likedPollRetry >= 60) {
                    clearInterval(pollId);
                    likedDownloadStates[awemeId].status = 'error';
                    renderLikedList();
                    showToast('下载轮询超时，请检查网络', 'error');
                }
            }
        }, 500);
    } catch (err) {
        likedDownloadStates[awemeId].status = 'error';
        renderLikedList();
        showToast('下载请求失败: ' + err.message, 'error');
    }
}

async function redownloadLikedItem(idx) {
    const item = likedSyncedItems[idx];
    if (!item) return;
    item.alreadyDownloaded = false;
    delete likedDownloadStates[item.awemeId];
    await downloadLikedItem(idx);
}

async function openLikedFile(idx) {
    const item = likedSyncedItems[idx];
    if (!item) return;
    const ds = likedDownloadStates[item.awemeId];
    const fp = (ds && ds.filePath) || item.filePath;
    if (fp) {
        await openHistoryFile(fp);
    } else {
        showToast('未找到本地文件路径', 'info');
    }
}

async function deleteLikedFile(idx) {
    const item = likedSyncedItems[idx];
    if (!item) return;
    const ds = likedDownloadStates[item.awemeId];
    const fp = (ds && ds.filePath) || item.filePath;
    if (!fp) {
        showToast('未找到本地文件路径', 'info');
        return;
    }
    if (!confirm(`确定删除文件？\n${fp}`)) return;
    try {
        await api('POST', '/api/history/delete', { filePath: fp });
        showToast('文件已删除', 'success');
        loadHistory();
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已经不存在了', 'info');
        } else {
            showToast('删除失败: ' + err.message, 'error');
            return;
        }
    }
    item.alreadyDownloaded = false;
    delete likedDownloadStates[item.awemeId];
    renderLikedList();
}

async function downloadAllLikedItems() {
    for (let i = 0; i < likedSyncedItems.length; i++) {
        const item = likedSyncedItems[i];
        if (item.alreadyDownloaded || item.parseError) continue;
        const ds = likedDownloadStates[item.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadLikedItem(i);
    }
}

function toggleLikedMultiSelectMode() {
    isLikedMultiSelectMode = !isLikedMultiSelectMode;
    if (!isLikedMultiSelectMode) {
        likedSelectedItems.clear();
    }
    renderLikedList();
}

function toggleLikedItemSelection(idx) {
    if (!isLikedMultiSelectMode) return;
    if (likedSelectedItems.has(idx)) {
        likedSelectedItems.delete(idx);
    } else {
        likedSelectedItems.add(idx);
    }
    renderLikedList();
}

function likedSelectAllUndownloaded() {
    likedSyncedItems.forEach((item, idx) => {
        const dState = likedDownloadStates[item.awemeId];
        const isDone = item.alreadyDownloaded || (dState && dState.status === 'done');
        if (!isDone && !item.parseError) {
            likedSelectedItems.add(idx);
        }
    });
    renderLikedList();
}

async function downloadSelectedLikedItems() {
    if (likedSelectedItems.size === 0) return;
    const targets = Array.from(likedSelectedItems);
    toggleLikedMultiSelectMode();
    
    for (const idx of targets) {
        const item = likedSyncedItems[idx];
        if (!item || item.parseError) continue;
        const ds = likedDownloadStates[item.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadLikedItem(idx);
    }
}

// ═══════════════════════════════════════════
// 私信同步
// ═══════════════════════════════════════════
async function stopMsgSync(taskId) {
    if(!confirm('确定要打断当前同步并结算已抓取的数据吗？')) return;
    try {
        await api('POST', '/api/messages/sync/stop', { taskId });
        showToast('已发送打断信号，请稍候...', 'info');
    } catch (err) {
        showToast('打断失败: ' + err.message, 'error');
    }
}

async function loadMsgStatus() {
    try {
        const status = await api('GET', '/api/favorites/status');
        updateMsgUI(status);
    } catch (err) {
        console.error('加载私信状态失败:', err);
    }
}

function updateMsgUI(status) {
    const syncBtn = document.getElementById('msgSyncBtn');
    if (syncBtn) {
        syncBtn.disabled = !status.loggedIn;
    }
}

async function handleMsgSync() {
    const syncBtn = document.getElementById('msgSyncBtn');
    if (!syncBtn) return;
    const maxCount = parseInt(document.getElementById('msgMaxCount').value) || 50;
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        setBtnText(syncBtn, '同步中 . . .');

        const result = await api('POST', '/api/messages/sync', { maxCount });
        if (result.taskId) {
            pollMsgSync(result.taskId);
        }
    } catch (err) {
        if (err.message.includes('已有同步任务')) {
            showToast('已有同步任务在进行中', 'error');
        } else if (err.message.includes('未登录') || err.message.includes('失效')) {
            showToast('登录态已失效，请先在凭证页面登录', 'error');
        } else {
            showToast('同步失败: ' + err.message, 'error');
        }
        syncBtn.classList.remove('syncing');
        syncBtn.disabled = false;
        setBtnText(syncBtn, '同步私信');
    }
}

function pollMsgSync(taskId) {
    const panel = document.getElementById('msgSyncPanel');
    if (!panel) return;
    panel.style.display = 'block';

    if (msgSyncPollTimer) clearInterval(msgSyncPollTimer);

    msgSyncPollTimer = setInterval(async () => {
        try {
            const task = await api('GET', `/api/messages/sync/${taskId}`);

            if (task.status === 'fetching') {
                panel.innerHTML = `
                    <div class="fav-sync-header">
                        <div>
                            <span class="fav-sync-phase">${escapeHTML(task.phase || '正在扫描私信...')}</span>
                            <span class="fav-sync-counter" style="margin-left:8px">已发现 ${task.collected || 0} 条</span>
                        </div>
                        <button class="btn btn--stop" style="padding:4px 10px;font-size:11px;border-radius:6px;color:var(--c-error);border:none;cursor:pointer;" onclick="stopMsgSync('${taskId}')">停止打断</button>
                    </div>
                    <div class="fav-sync-progress">
                        <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                    </div>
                `;
            } else if (task.status === 'done' || task.status === 'error') {
                clearInterval(msgSyncPollTimer);
                msgSyncPollTimer = null;

                const syncBtn = document.getElementById('msgSyncBtn');
                if (syncBtn) {
                    syncBtn.classList.remove('syncing');
                    syncBtn.disabled = false;
                    setBtnText(syncBtn, '同步私信');
                }
                loadMsgStatus();

                if (task.status === 'error') {
                    panel.innerHTML = `<div class="fav-login-hint" style="color:var(--c-error)">同步失败：${escapeHTML(task.error || '获取失败')}</div>`;
                    showToast('获取私信视频列表失败', 'error');
                } else {
                    msgSyncedItems = task.items || [];
                    msgDownloadStates = {};
                    renderMsgList();
                    const newCount = msgSyncedItems.filter(i => !i.alreadyDownloaded && !i.parseError).length;
                    showToast(`已获取 ${task.items.length} 条私信视频，${newCount} 条未下载`, 'success');
                }
            }
        } catch (err) {
            console.error('轮询私信同步进度失败:', err);
        }
    }, 1000);
}

async function downloadMsgItem(idx) {
    const item = msgSyncedItems[idx];
    if (!item) return;

    const awemeId = item.awemeId;
    if (msgDownloadStates[awemeId] && msgDownloadStates[awemeId].status === 'downloading') return;

    item.alreadyDownloaded = false;
    msgDownloadStates[awemeId] = { status: 'downloading', progress: 0 };
    renderMsgList();

    try {
        const result = await api('POST', '/api/download', {
            type: item.type,
            videoUrl: item.videoUrl,
            images: item.images,
            livePhotos: item.livePhotos,
            cover: item.cover,
            title: item.title,
            awemeId: item.awemeId,
            platform: item.platform || 'douyin',
        });
        if (!result.taskId) throw new Error('No taskId');

        let msgPollRetry = 0;
        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                msgPollRetry = 0;
                msgDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    msgDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    item.alreadyDownloaded = true;
                    renderMsgList();
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    msgDownloadStates[awemeId].status = 'error';
                    renderMsgList();
                    showToast(`下载失败: ${escapeHTML(task.error || '未知错误')}`, 'error');
                } else {
                    renderMsgList();
                }
            } catch (e) {
                msgPollRetry++;
                if (msgPollRetry >= 60) {
                    clearInterval(pollId);
                    msgDownloadStates[awemeId].status = 'error';
                    renderMsgList();
                    showToast('下载轮询超时，请检查网络', 'error');
                }
            }
        }, 500);
    } catch (err) {
        msgDownloadStates[awemeId].status = 'error';
        renderMsgList();
        showToast('下载请求失败: ' + err.message, 'error');
    }
}

async function redownloadMsgItem(idx) {
    const item = msgSyncedItems[idx];
    if (!item) return;
    item.alreadyDownloaded = false;
    delete msgDownloadStates[item.awemeId];
    await downloadMsgItem(idx);
}

async function openMsgFile(idx) {
    const item = msgSyncedItems[idx];
    if (!item) return;
    const ds = msgDownloadStates[item.awemeId];
    const fp = (ds && ds.filePath) || item.filePath;
    if (fp) {
        await openHistoryFile(fp);
    } else {
        showToast('未找到本地文件路径', 'info');
    }
}

async function deleteMsgFile(idx) {
    const item = msgSyncedItems[idx];
    if (!item) return;
    const ds = msgDownloadStates[item.awemeId];
    const fp = (ds && ds.filePath) || item.filePath;
    if (!fp) {
        showToast('未找到本地文件路径', 'info');
        return;
    }
    if (!confirm(`确定删除文件？\n${fp}`)) return;
    try {
        await api('POST', '/api/history/delete', { filePath: fp });
        showToast('文件已删除', 'success');
        loadHistory();
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已经不存在了', 'info');
        } else {
            showToast('删除失败: ' + err.message, 'error');
            return;
        }
    }
    item.alreadyDownloaded = false;
    delete msgDownloadStates[item.awemeId];
    renderMsgList();
}

async function downloadAllMsgItems() {
    for (let i = 0; i < msgSyncedItems.length; i++) {
        const item = msgSyncedItems[i];
        if (item.alreadyDownloaded || item.parseError) continue;
        const ds = msgDownloadStates[item.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadMsgItem(i);
    }
}

function toggleMsgMultiSelectMode() {
    isMsgMultiSelectMode = !isMsgMultiSelectMode;
    if (!isMsgMultiSelectMode) {
        msgSelectedItems.clear();
    }
    renderMsgList();
}

function toggleMsgItemSelection(idx) {
    if (!isMsgMultiSelectMode) return;
    if (msgSelectedItems.has(idx)) {
        msgSelectedItems.delete(idx);
    } else {
        msgSelectedItems.add(idx);
    }
    renderMsgList();
}

function msgSelectAllUndownloaded() {
    msgSyncedItems.forEach((item, idx) => {
        const dState = msgDownloadStates[item.awemeId];
        const isDone = item.alreadyDownloaded || (dState && dState.status === 'done');
        if (!isDone && !item.parseError) {
            msgSelectedItems.add(idx);
        }
    });
    renderMsgList();
}

async function downloadSelectedMsgItems() {
    if (msgSelectedItems.size === 0) return;
    const targets = Array.from(msgSelectedItems);
    toggleMsgMultiSelectMode();

    for (const idx of targets) {
        const item = msgSyncedItems[idx];
        if (!item || item.parseError) continue;
        const ds = msgDownloadStates[item.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadMsgItem(idx);
    }
}

// ═══════════════════════════════════════════
// 定时同步设置
// ═══════════════════════════════════════════
function toggleSchedulePanel() {
    const panel = document.getElementById('schedulePanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') {
        loadScheduleConfig();
    }
}

async function loadScheduleConfig() {
    try {
        const cfg = await api('GET', '/api/schedule/config');
        const enabledCheckbox = document.getElementById('scheduleEnabled');
        if (enabledCheckbox) enabledCheckbox.checked = cfg.enabled;
        
        const syncModeSelect = document.getElementById('scheduleSyncMode');
        if (syncModeSelect) syncModeSelect.value = cfg.syncMode || 'both';
        
        const maxCountInput = document.getElementById('scheduleMaxCount');
        if (maxCountInput) maxCountInput.value = cfg.maxCount || 50;

        // 将 cron 表达式转为 HH:MM 时间展示
        const cronParts = (cfg.cronTime || '0 0 * * *').split(' ');
        const hour = (cronParts[1] || '0').padStart(2, '0');
        const minute = (cronParts[0] || '0').padStart(2, '0');
        const timeInput = document.getElementById('scheduleTime');
        if (timeInput) timeInput.value = `${hour}:${minute}`;

        // 随机触发模式
        const triggerMode = cfg.triggerMode || 'fixed';
        const triggerModeSelect = document.getElementById('scheduleTriggerMode');
        if (triggerModeSelect) triggerModeSelect.value = triggerMode;
        
        const rangeStartInput = document.getElementById('scheduleRangeStart');
        if (rangeStartInput) rangeStartInput.value = cfg.rangeStart || '00:00';
        
        const rangeEndInput = document.getElementById('scheduleRangeEnd');
        if (rangeEndInput) rangeEndInput.value = cfg.rangeEnd || '06:00';
        
        onTriggerModeChange();
        updateScheduleBadge(cfg.enabled);
    } catch (err) {
        console.error('加载定时配置失败:', err);
    }
}

function updateScheduleBadge(enabled) {
    const badge = document.getElementById('scheduleBadge');
    const text = document.getElementById('scheduleStatusText');
    if (badge) {
        if (enabled) {
            badge.style.display = 'inline-flex';
            if (text) text.textContent = '运行中';
        } else {
            badge.style.display = 'none';
        }
    }
}

function onTriggerModeChange() {
    const modeSelect = document.getElementById('scheduleTriggerMode');
    if (!modeSelect) return;
    const mode = modeSelect.value;
    
    const fixedRow = document.getElementById('scheduleFixedRow');
    if (fixedRow) fixedRow.style.display = mode === 'fixed' ? 'flex' : 'none';
    
    const randomRow = document.getElementById('scheduleRandomRow');
    if (randomRow) randomRow.style.display = mode === 'random' ? 'flex' : 'none';
}

async function saveScheduleConfig() {
    const enabledCheckbox = document.getElementById('scheduleEnabled');
    const enabled = enabledCheckbox ? enabledCheckbox.checked : false;
    
    const triggerModeSelect = document.getElementById('scheduleTriggerMode');
    const triggerMode = triggerModeSelect ? triggerModeSelect.value : 'fixed';
    
    const timeInput = document.getElementById('scheduleTime');
    const timeVal = timeInput ? (timeInput.value || '00:00') : '00:00';
    
    const syncModeSelect = document.getElementById('scheduleSyncMode');
    const syncMode = syncModeSelect ? syncModeSelect.value : 'both';
    
    const maxCountInput = document.getElementById('scheduleMaxCount');
    const maxCount = maxCountInput ? (parseInt(maxCountInput.value) || 50) : 50;
    
    const rangeStartInput = document.getElementById('scheduleRangeStart');
    const rangeStart = rangeStartInput ? (rangeStartInput.value || '00:00') : '00:00';
    
    const rangeEndInput = document.getElementById('scheduleRangeEnd');
    const rangeEnd = rangeEndInput ? (rangeEndInput.value || '06:00') : '06:00';

    // 固定模式使用 cron
    const [hour, minute] = timeVal.split(':');
    const cronTime = `${parseInt(minute)} ${parseInt(hour)} * * *`;

    try {
        await api('POST', '/api/schedule/config', { enabled, cronTime, syncMode, maxCount, triggerMode, rangeStart, rangeEnd });
        updateScheduleBadge(enabled);
        showToast('定时同步配置已保存', 'success');
    } catch (err) {
        showToast('保存失败: ' + err.message, 'error');
    }
}

async function triggerScheduleNow() {
    try {
        await api('POST', '/api/schedule/run');
        showToast('已触发定时同步，后台正在执行...', 'success');
    } catch (err) {
        showToast('触发失败: ' + err.message, 'error');
    }
}

async function loadScheduleLogs() {
    const logPanel = document.getElementById('scheduleLogPanel');
    if (!logPanel) return;
    logPanel.style.display = 'block';
    logPanel.innerHTML = '加载中...';
    try {
        const logs = await api('GET', '/api/schedule/logs');
        if (!logs || logs.length === 0) {
            logPanel.innerHTML = '<div style="text-align:center;padding:10px;">暂无执行记录</div>';
            return;
        }
        logPanel.innerHTML = logs.map(log => {
            const time = new Date(log.time).toLocaleString('zh-CN');
            const modeLabel = { both: '收藏+喜欢', favorites: '仅收藏', liked: '仅喜欢' }[log.syncMode] || escapeHTML(log.syncMode);
            if (log.error) {
                return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);">
                    <span style="color:var(--c-error);">✕</span> ${time} [${modeLabel}] ${escapeHTML(log.error)}
                </div>`;
            }
            const r = log.results || {};
            return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);">
                <span style="color:var(--c-success);">✓</span> ${time} [${modeLabel}] 发现${log.totalFound || 0}条 → 下载${log.toDownload || 0}条 (成功${r.success || 0} / 失败${r.fail || 0})
            </div>`;
        }).join('');
    } catch (err) {
        logPanel.innerHTML = `<div style="color:var(--c-error);">加载失败: ${escapeHTML(err.message)}</div>`;
    }
}

// ── 用户主页同步前端逻辑 ──
async function handleUserSync(cardId, secUid) {
    const item = appState.items[cardId];
    if (!item) return;

    if (item.syncType === undefined) {
        item.syncType = 'post';
    }

    item.syncStatus = 'fetching';
    item.syncPhase = '正在发起同步请求...';
    item.syncCollected = 0;
    updateCard(cardId);

    try {
        const result = await api('POST', '/api/user/sync', { 
            secUid, 
            maxCount: item.syncMaxCount,
            tabType: item.syncType
        });
        if (!result.taskId) throw new Error('同步请求失败，未返回任务 ID');
        item.syncTaskId = result.taskId;
        pollUserSync(cardId, result.taskId);
    } catch (err) {
        item.syncStatus = 'error';
        item.error = err.message;
        updateCard(cardId);
        showToast('提取列表失败: ' + err.message, 'error');
    }
}

function pollUserSync(cardId, taskId) {
    const item = appState.items[cardId];
    if (!item) return;

    if (appState.pollTimers[cardId]) clearInterval(appState.pollTimers[cardId]);

    appState.pollTimers[cardId] = setInterval(async () => {
        try {
            const task = await api('GET', `/api/user/sync/${taskId}`);
            item.syncPhase = task.phase || '正在同步列表...';
            item.syncCollected = task.collected || 0;
            if (task.nickname) item.nickname = task.nickname;
            if (task.tabType) item.syncType = task.tabType;

            if (task.status === 'done' || task.status === 'error') {
                clearInterval(appState.pollTimers[cardId]);
                delete appState.pollTimers[cardId];

                const label = item.syncType === 'like' ? '喜欢' : '作品';

                if (task.status === 'error') {
                    item.syncStatus = 'error';
                    item.error = task.error || `获取${label}列表失败`;
                    updateCard(cardId);
                    showToast(`获取${label}列表失败`, 'error');
                } else {
                    item.syncStatus = 'done';
                    item.userItems = task.items || [];
                    item.userDownloadStates = {};
                    item.selectedItems.clear();
                    updateCard(cardId);
                    const newCount = item.userItems.filter(i => !i.alreadyDownloaded && !i.parseError).length;
                    showToast(`已获取 ${task.items.length} 条${label}，${newCount} 条未下载`, 'success');
                }
            } else {
                updateCard(cardId);
            }
        } catch (err) {
            console.error('轮询用户同步进度失败:', err);
        }
    }, 1000);
}

async function stopUserSync(cardId) {
    const item = appState.items[cardId];
    if (!item || !item.syncTaskId) return;
    try {
        await api('POST', '/api/user/sync/stop', { taskId: item.syncTaskId });
        showToast('已发送停止指令', 'info');
    } catch (e) {
        showToast('停止同步失败: ' + e.message, 'error');
    }
}

function resetUserSync(cardId) {
    const item = appState.items[cardId];
    if (!item) return;
    item.syncStatus = 'idle';
    item.userItems = [];
    item.userDownloadStates = {};
    item.selectedItems.clear();
    updateCard(cardId);
}

function toggleUserDownloadedList(cardId) {
    const item = appState.items[cardId];
    if (!item) return;
    item.downloadedExpanded = !item.downloadedExpanded;
    updateCard(cardId);
}

function toggleUserMultiSelectMode(cardId) {
    const item = appState.items[cardId];
    if (!item) return;
    item.isMultiSelectMode = !item.isMultiSelectMode;
    if (!item.isMultiSelectMode) {
        item.selectedItems.clear();
    }
    updateCard(cardId);
}

function toggleUserItemSelection(cardId, idx) {
    const item = appState.items[cardId];
    if (!item) return;
    if (item.selectedItems.has(idx)) {
        item.selectedItems.delete(idx);
    } else {
        item.selectedItems.add(idx);
    }
    updateCard(cardId);
}

function userSelectRecent(cardId, count) {
    const item = appState.items[cardId];
    if (!item) return;
    item.isMultiSelectMode = true;
    item.selectedItems.clear();
    let selectedCount = 0;
    for (let idx = 0; idx < item.userItems.length; idx++) {
        const uItem = item.userItems[idx];
        if (!uItem.alreadyDownloaded && !uItem.parseError) {
            const ds = item.userDownloadStates[uItem.awemeId];
            const isDone = ds && ds.status === 'done';
            if (!isDone) {
                item.selectedItems.add(idx);
                selectedCount++;
                if (selectedCount >= count) {
                    break;
                }
            }
        }
    }
    updateCard(cardId);
}

function userSelectAllUndownloaded(cardId) {
    const item = appState.items[cardId];
    if (!item) return;
    item.selectedItems.clear();
    item.userItems.forEach((uItem, idx) => {
        if (!uItem.alreadyDownloaded && !uItem.parseError) {
            const ds = item.userDownloadStates[uItem.awemeId];
            const isDone = ds && ds.status === 'done';
            if (!isDone) {
                item.selectedItems.add(idx);
            }
        }
    });
    updateCard(cardId);
}

async function downloadUserItem(cardId, idx, subDir = '') {
    const item = appState.items[cardId];
    if (!item) return;
    const uItem = item.userItems[idx];
    if (!uItem) return;

    const awemeId = uItem.awemeId;
    if (item.userDownloadStates[awemeId] && item.userDownloadStates[awemeId].status === 'downloading') return;

    uItem.alreadyDownloaded = false;
    item.userDownloadStates[awemeId] = { status: 'downloading', progress: 0 };
    updateCard(cardId);

    try {
        const result = await api('POST', '/api/download', {
            type: uItem.type,
            videoUrl: uItem.videoUrl,
            images: uItem.images,
            livePhotos: uItem.livePhotos,
            cover: uItem.cover,
            title: uItem.title,
            awemeId: uItem.awemeId,
            platform: uItem.platform || 'douyin',
            subDir: subDir || '',
        });
        if (!result.taskId) throw new Error('No taskId');

        let userPollRetry = 0;
        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                userPollRetry = 0;
                if (!item.userDownloadStates[awemeId]) {
                    clearInterval(pollId);
                    return;
                }
                item.userDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    item.userDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    uItem.alreadyDownloaded = true;
                    updateCard(cardId);
                    addToHistory({
                        fileName: task.fileName,
                        filePath: task.filePath,
                        fileSize: task.fileSize,
                        info: { title: uItem.title, cover: uItem.cover, type: uItem.type },
                    });
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    item.userDownloadStates[awemeId].status = 'error';
                    updateCard(cardId);
                    showToast(`下载失败: ${escapeHTML(task.error || '未知错误')}`, 'error');
                } else {
                    updateCard(cardId);
                }
            } catch (e) {
                userPollRetry++;
                if (userPollRetry >= 60) {
                    clearInterval(pollId);
                    if (item.userDownloadStates[awemeId]) {
                        item.userDownloadStates[awemeId].status = 'error';
                    }
                    updateCard(cardId);
                    showToast('下载轮询超时，请检查网络', 'error');
                }
            }
        }, 500);
    } catch (err) {
        item.userDownloadStates[awemeId].status = 'error';
        updateCard(cardId);
        showToast('下载请求失败: ' + err.message, 'error');
    }
}

async function redownloadUserItem(cardId, idx) {
    const item = appState.items[cardId];
    if (!item) return;
    const uItem = item.userItems[idx];
    if (!uItem) return;
    uItem.alreadyDownloaded = false;
    delete item.userDownloadStates[uItem.awemeId];
    await downloadUserItem(cardId, idx);
}

async function openUserFile(cardId, idx) {
    const item = appState.items[cardId];
    if (!item) return;
    const uItem = item.userItems[idx];
    if (!uItem) return;
    const ds = item.userDownloadStates[uItem.awemeId];
    const fp = (ds && ds.filePath) || uItem.filePath;
    if (fp) {
        await openHistoryFile(fp);
    } else {
        showToast('未找到本地文件路径', 'info');
    }
}

async function deleteUserFile(cardId, idx) {
    const item = appState.items[cardId];
    if (!item) return;
    const uItem = item.userItems[idx];
    if (!uItem) return;
    const ds = item.userDownloadStates[uItem.awemeId];
    const fp = (ds && ds.filePath) || uItem.filePath;
    if (!fp) {
        showToast('未找到本地文件路径', 'info');
        return;
    }
    if (!confirm(`确定删除文件？\n${fp}`)) return;
    try {
        await api('POST', '/api/history/delete', { filePath: fp });
        showToast('文件已删除', 'success');
        loadHistory();
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已经不存在了', 'info');
        } else {
            showToast('删除失败: ' + err.message, 'error');
            return;
        }
    }
    uItem.alreadyDownloaded = false;
    delete item.userDownloadStates[uItem.awemeId];
    updateCard(cardId);
}

async function downloadSelectedUserItems(cardId) {
    const item = appState.items[cardId];
    if (!item) return;
    const indices = Array.from(item.selectedItems);
    
    const toDownload = indices.filter(idx => {
        const uItem = item.userItems[idx];
        if (!uItem || uItem.alreadyDownloaded || uItem.parseError) return false;
        const ds = item.userDownloadStates[uItem.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) return false;
        return true;
    });

    item.isMultiSelectMode = false;
    item.selectedItems.clear();
    updateCard(cardId);

    let subDir = '';
    if (toDownload.length > 1) {
        const nickname = item.nickname || (item.info && item.info.author && item.info.author.nickname) || '抖音用户';
        const typeSuffix = item.syncType === 'like' ? '_喜欢' : '';
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        subDir = `${nickname}${typeSuffix}_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
    }
    
    for (const idx of toDownload) {
        await downloadUserItem(cardId, idx, subDir);
    }
}

async function downloadAllUserItems(cardId) {
    const item = appState.items[cardId];
    if (!item) return;

    const toDownload = [];
    for (let i = 0; i < item.userItems.length; i++) {
        const uItem = item.userItems[i];
        if (uItem.alreadyDownloaded || uItem.parseError) continue;
        const ds = item.userDownloadStates[uItem.awemeId];
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        toDownload.push(i);
    }

    let subDir = '';
    if (toDownload.length > 1) {
        const nickname = item.nickname || (item.info && item.info.author && item.info.author.nickname) || '抖音用户';
        const typeSuffix = item.syncType === 'like' ? '_喜欢' : '';
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        subDir = `${nickname}${typeSuffix}_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
    }

    for (const idx of toDownload) {
        await downloadUserItem(cardId, idx, subDir);
    }
}
