/* ═══════════════════════════════════════════
   抖音视频下载器 — 前端逻辑 (重构以支持多任务与图文)
   ═══════════════════════════════════════════ */

// ── 全局状态 ──
let appState = {
    items: {}, // key: id, value: { url, info, loading, error, status, progress, total, downloaded, fileSize, taskId, fileName, downloadError }
    pollTimers: {} // key: id, value: interval timer
};

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    loadHistory();
    loadFavStatus();
    loadLikedStatus();
    loadMsgStatus();
    loadScheduleConfig();

    document.getElementById('urlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleParse();
        }
    });

    document.getElementById('urlInput').addEventListener('paste', () => {
        setTimeout(() => handleParse(), 100);
    });
});

// ── Tab 切换 ──
function switchSyncTab(tab) {
    document.querySelectorAll('.sync-tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sync-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelector(`.sync-tab[data-tab="${tab}"]`).classList.add('active');
    const tabMap = { fav: 'tabFav', liked: 'tabLiked', messages: 'tabMessages', schedule: 'tabSchedule', auth: 'tabAuth' };
    document.getElementById(tabMap[tab]).classList.add('active');
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
    el.value = '';
    handleInputResize(el);
    el.focus();
}

// ── API 封装 ──
async function api(method, url, body) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) options.body = JSON.stringify(body);

    const resp = await fetch(url, options);
    const data = await resp.json();

    if (!resp.ok) {
        throw new Error(data.error || `请求失败 (${resp.status})`);
    }
    return data;
}

// ── 配置 ──
async function loadConfig() {
    try {
        const config = await api('GET', '/api/config');
        document.getElementById('downloadDir').value = config.downloadDir || '';
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

// ── 解析逻辑 ──
async function handleParse() {
    const input = document.getElementById('urlInput');
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
    container.innerHTML = '';

    // 取消所有进行中的轮询
    Object.values(appState.pollTimers).forEach(clearInterval);
    appState.items = {};
    appState.pollTimers = {};

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const id = 'task_' + Date.now() + '_' + i;
        appState.items[id] = { id, url, loading: true };
        appendCardPlaceHolder(id);

        api('POST', '/api/parse', { url })
            .then(res => {
                appState.items[id] = { ...appState.items[id], loading: false, info: res.data };
                updateCard(id);
            })
            .catch(err => {
                appState.items[id] = { ...appState.items[id], loading: false, error: err.message };
                updateCard(id);
            });
    }

    setLoading(btn, false);
}

// ── 卡片渲染 ──
function appendCardPlaceHolder(id) {
    const container = document.getElementById('resultsContainer');
    const div = document.createElement('div');
    div.id = id;
    div.className = 'video-info';
    container.appendChild(div);
    updateCard(id);
}

function updateCard(id) {
    const item = appState.items[id];
    const el = document.getElementById(id);
    if (!el) return;

    if (item.loading) {
        el.innerHTML = `
            <div class="video-card" style="justify-content:center; padding:30px;">
                <div class="btn-loader" style="display:block; border-top-color:var(--c-primary); width:24px; height:24px;"></div>
                <div style="margin-left:12px; color:var(--c-text-muted); font-size:14px;">解析中...</div>
            </div>`;
        return;
    }

    if (item.error) {
        el.innerHTML = `
            <div class="video-card" style="border-color: rgba(248, 113, 113, 0.4);">
                <div class="video-meta">
                    <p style="color:var(--c-error); font-weight:500;">解析失败: ${item.error}</p>
                    <p style="font-size:12px; color:var(--c-text-muted); margin-top:8px; word-break:break-all;">${item.url}</p>
                </div>
            </div>`;
        return;
    }

    const info = item.info;
    const isImage = info.type === 'image';

    let durationHtml = '';
    if (!isImage && info.duration) {
        const sec = Math.round(info.duration / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        durationHtml = `<div class="video-duration">${m}:${s.toString().padStart(2, '0')}</div>`;
    } else if (isImage) {
        const count = info.images ? info.images.length : 0;
        durationHtml = `<div class="video-duration" style="background:var(--c-primary)">图文: ${count}P</div>`;
    }

    let resHtml = '';
    if (!isImage && info.width && info.height) {
        resHtml = `<span class="spec">${info.width} × ${info.height}</span>`;
    } else if (isImage) {
        resHtml = `<span class="spec">图集无水印下载</span>`;
    }

    const btnDisabled = item.status === 'downloading' || item.status === 'done';
    let btnText = isImage ? '下载全部高清源图' : '下载无水印原视频';
    if (item.status === 'downloading') btnText = '下载中...';
    if (item.status === 'done') btnText = '✓ 已完成';

    let progressHtml = '';
    if (item.status === 'downloading' || item.taskId || item.status === 'done' || item.status === 'error') {
        const pLabel = item.status === 'done' ? '✓ 下载完成' : (item.status === 'error' ? '✕ 下载失败' : '下载中…');
        const pNum = item.progress || 0;

        let pDetail = '';
        if (item.status === 'done' && item.fileSize) {
            pDetail = `${item.fileName} (${formatBytes(item.fileSize)})`;
        } else if (item.status === 'error') {
            pDetail = item.downloadError || '出错了，请检查后台日志';
        } else if (item.total > 0) {
            pDetail = `${formatBytes(item.downloaded)} / ${formatBytes(item.total)}`;
        }

        progressHtml = `
          <div class="download-progress" style="margin-top: 16px;">
            <div class="progress-header">
              <span class="progress-label" style="color: ${item.status === 'error' ? 'var(--c-error)' : (item.status === 'done' ? 'var(--c-success)' : '')}">${pLabel}</span>
              <span class="progress-percent">${pNum}%</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${pNum}%"></div>
            </div>
            <div class="progress-detail">${pDetail}</div>
          </div>
        `;
    }

    el.innerHTML = `
      <div class="video-card">
        <div class="video-cover-wrap">
          <img class="video-cover" src="${info.cover || ''}" alt="封面">
          ${durationHtml}
        </div>
        <div class="video-meta">
          <h2 class="video-title" title="${info.title}">${info.title}</h2>
          <div class="video-author">
            <span class="author-label">作者</span>
            <span>${info.author}</span>
          </div>
          <div class="video-specs">
            ${resHtml}
          </div>
          <button class="btn btn--download" onclick="handleDownload('${id}')" ${btnDisabled ? 'disabled' : ''}>
            <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>${btnText}</span>
          </button>
        </div>
      </div>
      ${progressHtml}
    `;
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
            title: item.info.title,
            awemeId: item.info.awemeId,
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

function startPolling(id) {
    const item = appState.items[id];
    if (appState.pollTimers[id]) clearInterval(appState.pollTimers[id]);

    appState.pollTimers[id] = setInterval(async () => {
        if (!item.taskId) return;
        try {
            const task = await api('GET', `/api/download/${item.taskId}`);
            item.progress = task.progress || 0;
            item.downloaded = task.downloaded || 0;
            item.total = task.total || 0;

            if (task.status === 'done') {
                clearInterval(appState.pollTimers[id]);
                item.status = 'done';
                item.fileSize = task.fileSize;
                item.fileName = task.fileName;
                item.filePath = task.filePath;
                updateCard(id);
                onDownloadComplete(item);
            } else if (task.status === 'error') {
                clearInterval(appState.pollTimers[id]);
                item.status = 'error';
                item.downloadError = task.error;
                updateCard(id);
                showToast('下载失败: ' + (task.error || '未知错误'), 'error');
            } else {
                updateCard(id);
            }
        } catch (err) {
            console.error('轮询失败:', err);
        }
    }, 500);
}

function onDownloadComplete(item) {
    showToast(`${item.info.type === 'image' ? '图文' : '视频'}下载完成！`, 'success');
    addToHistory(item);
    loadHistory();
}

// ── 错误与工具类 ──
function showError(msg) {
    const el = document.getElementById('errorMsg');
    if (el) {
        el.textContent = msg;
        el.style.display = 'block';
    } else {
        showToast(msg, 'error');
    }
}

function hideError() {
    const el = document.getElementById('errorMsg');
    if (el) el.style.display = 'none';
}

function setLoading(btn, loading) {
    if (!btn) return;
    const text = btn.querySelector('.btn-text');
    const loader = btn.querySelector('.btn-loader');
    if (loading) {
        text.style.display = 'none';
        loader.style.display = 'inline-block';
        btn.disabled = true;
    } else {
        text.style.display = 'inline';
        loader.style.display = 'none';
        btn.disabled = false;
    }
}

function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ── 历史记录 ──
function addToHistory(item) {
    let history = JSON.parse(localStorage.getItem('dy_history') || '[]');
    history.unshift({
        title: item.fileName || item.info.title,
        author: item.info ? item.info.author : '',
        fileName: item.fileName,
        filePath: item.filePath,
        fileSize: item.fileSize,
        cover: item.info ? item.info.cover : '',
        time: Date.now(),
    });
    history = history.slice(0, 200);
    localStorage.setItem('dy_history', JSON.stringify(history));
}

function loadHistory() {
    const history = JSON.parse(localStorage.getItem('dy_history') || '[]');
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    const filtersEl = document.getElementById('historyFilters');

    if (history.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    filtersEl.style.display = history.length > 3 ? 'flex' : 'none';

    // Populate author filter
    const authorSelect = document.getElementById('historyFilterAuthor');
    const currentAuthorVal = authorSelect.value;
    const authors = [...new Set(history.map(h => h.author).filter(Boolean))];
    authorSelect.innerHTML = '<option value="">全部作者</option>' + authors.map(a => `<option value="${a}"${a === currentAuthorVal ? ' selected' : ''}>@${a}</option>`).join('');

    // Apply filters
    const keyword = (document.getElementById('historyFilterKeyword').value || '').trim().toLowerCase();
    const authorFilter = document.getElementById('historyFilterAuthor').value;
    const dateFilter = document.getElementById('historyFilterDate').value;

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
            ? `<img class="history-thumb" src="${item.cover}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">` + `<div class="history-thumb-placeholder" style="display:none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`
            : placeholderHtml;
        const authorStr = item.author ? `<span style="font-size:11px;color:var(--c-text-muted);">@${item.author}</span>` : '';
        const timeStr = item.time ? `<span style="font-size:11px;color:var(--c-text-muted);">${new Date(item.time).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>` : '';
        return `
      <div class="history-item">
        ${thumbHtml}
        <div class="history-info">
          <span class="history-name" title="${item.filePath || ''}">${item.title || item.fileName}</span>
          <div class="history-meta">
            ${authorStr}
            ${timeStr}
            <span class="history-status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>Completed</span>
            <span class="history-size">${formatBytes(item.fileSize)}</span>
          </div>
        </div>
        <div class="history-actions">
          <button class="action-btn action-btn--open" onclick="openHistoryFile('${(item.filePath || '').replace(/\\/g, '\\\\')}')" title="在文件夹中显示">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="action-btn action-btn--delete" onclick="deleteHistoryFile('${(item.filePath || '').replace(/\\/g, '\\\\')}', ${realIndex})" title="从磁盘删除文件">
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

async function deleteHistoryFile(filePath, index) {
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
        let history = JSON.parse(localStorage.getItem('dy_history') || '[]');
        history.splice(index, 1);
        localStorage.setItem('dy_history', JSON.stringify(history));
        loadHistory();
    }
}

function clearHistory() {
    localStorage.removeItem('dy_history');
    loadHistory();
    showToast('历史记录已清空', 'success');
}

// ── 设置面板 ──
function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    const chevron = document.getElementById('settingsChevron');

    if (panel.style.display === 'none' || panel.style.display === '') {
        panel.style.display = 'block';
        chevron.classList.add('open');
    } else {
        panel.style.display = 'none';
        chevron.classList.remove('open');
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

// ── Toast ──
function showToast(msg, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ═══════════════════════════════════════════
// 收藏同步
// ═══════════════════════════════════════════

let favSyncPollTimer = null;
let favIsLoggedIn = false;
let favLoginPollTimer = null;
let favSyncedItems = [];
let favDownloadStates = {};
let isFavMultiSelectMode = false;
let favSelectedItems = new Set();

async function stopFavSync(taskId) {
    if(!confirm('确定要打断当前同步并结算已抓取的数据吗？')) return;
    try {
        await api('POST', '/api/favorites/sync/stop', { taskId });
        showToast('已发送打断信号，请稍候...', 'info');
    } catch (err) {
        showToast('打断失败: ' + err.message, 'error');
    }
}

/**
 * 加载收藏同步状态
 */
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
    const accountBtn = document.getElementById('syncAccountBtn');
    const accountBtnText = document.getElementById('favAccountBtnText');
    const syncBtn = document.getElementById('favSyncBtn');

    if (status.loggedIn) {
        badge.style.display = 'inline-flex';
        document.getElementById('syncBadgeText').textContent =
            status.lastSyncTime ? `同步 ${formatSyncTime(status.lastSyncTime)}` : '已登录';
        accountBtnText.textContent = '切换账号';
        syncBtn.disabled = false;
    } else {
        badge.style.display = 'none';
        accountBtnText.textContent = '登录';
        syncBtn.disabled = true;
    }
}

function formatSyncTime(isoStr) {
    try {
        const d = new Date(isoStr);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
    } catch {
        return '';
    }
}

/**
 * 账号按钮：登录 / 切换账号（退出后重新登录）
 */
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

function toggleCookieLogin(e) {
    if (e) e.preventDefault();
}

/**
 * 提交手动注入的 Cookie
 */
async function handleCookieSubmit() {
    const input = document.getElementById('cookieInput');
    const cookieVal = input.value.trim();
    const btn = document.getElementById('cookieSubmitBtn');
    
    if (!cookieVal) {
        showToast('请先输入 Cookie 值', 'warning');
        return;
    }

    btn.disabled = true;
    btn.textContent = '绑定中...';

    try {
        await api('POST', '/api/favorites/cookie-login', { cookie: cookieVal });
        input.value = '';
        showToast('绑定成功！', 'success');
        await loadFavStatus();
        switchSyncTab('fav');
    } catch (err) {
        showToast('绑定失败: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '绑定凭证';
    }
}

/**
 * 检测当前本地下载任务情况，构建 "未下载" 和 "已下载" 分组
 */
async function handleFavoritesSync() {
    const syncBtn = document.getElementById('favSyncBtn');
    const maxCount = parseInt(document.getElementById('favMaxCount').value) || 50;
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        syncBtn.querySelector('.btn-label').textContent = '同步中 . . .';

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
        syncBtn.querySelector('.btn-label').textContent = '同步收藏';
    }
}

/**
 * 轮询同步任务（只拉取列表阶段）
 */
function pollFavSync(taskId) {
    const panel = document.getElementById('favSyncPanel');
    panel.style.display = 'block';

    if (favSyncPollTimer) clearInterval(favSyncPollTimer);

    favSyncPollTimer = setInterval(async () => {
        try {
            const task = await api('GET', `/api/favorites/sync/${taskId}`);

            if (task.status === 'fetching') {
                panel.innerHTML = `
                    <div class="fav-sync-header">
                        <div>
                            <span class="fav-sync-phase">${task.phase || '正在获取收藏列表...'}</span>
                            <span class="fav-sync-counter" style="margin-left:8px">已发现 ${task.collected || 0} 条</span>
                        </div>
                        <button class="btn btn--stop" style="padding:4px 10px;font-size:11px;border-radius:6px;color:white;border:none;cursor:pointer;" onclick="stopFavSync('${taskId}')">停止打断</button>
                    </div>
                    <div class="fav-sync-progress">
                        <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                    </div>
                `;
            } else if (task.status === 'done' || task.status === 'error') {
                clearInterval(favSyncPollTimer);
                favSyncPollTimer = null;

                const syncBtn = document.getElementById('favSyncBtn');
                syncBtn.classList.remove('syncing');
                syncBtn.disabled = false;
                syncBtn.querySelector('.btn-label').textContent = '同步收藏';
                loadFavStatus();

                if (task.status === 'error') {
                    panel.innerHTML = `<div class="fav-login-hint" style="color:var(--c-error)">❌ ${task.error || '获取失败'}</div>`;
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

/**
 * 渲染收藏列表（分两组：未下载 + 已下载折叠）
 */
let favDownloadedExpanded = false;

function renderFavList() {
    const panel = document.getElementById('favSyncPanel');
    if (!favSyncedItems || favSyncedItems.length === 0) {
        panel.innerHTML = '<div class="fav-login-hint">收藏列表为空</div>';
        return;
    }

    const undownloaded = [];
    const downloaded = [];
    const errored = [];

    favSyncedItems.forEach((item, idx) => {
        item._idx = idx;
        if (item.parseError) {
            errored.push(item);
        } else {
            const ds = favDownloadStates[item.awemeId];
            const isDone = item.alreadyDownloaded || (ds && ds.status === 'done');
            if (isDone) {
                downloaded.push(item);
            } else {
                undownloaded.push(item);
            }
        }
    });

    let html = '';

    // 处理多选模式头部
    if (isFavMultiSelectMode) {
        html += `<div class="multi-select-bar">
            <span style="font-size:13px;font-weight:600;color:var(--c-primary)">已选 ${favSelectedItems.size} 项</span>
            <div class="multi-select-actions">
                <button class="btn btn--secondary" style="padding:5px 10px;font-size:12px;border-radius:6px" onclick="favSelectAllUndownloaded()">全选未下载</button>
                <button class="btn btn--secondary" style="padding:5px 10px;font-size:12px;border-radius:6px" onclick="toggleFavMultiSelectMode()">取消</button>
                <button class="btn btn--sync" style="padding:5px 12px;font-size:12px;border-radius:6px" onclick="downloadSelectedFavItems()" ${favSelectedItems.size === 0 ? 'disabled' : ''}>下载所选</button>
            </div>
        </div>`;
    }

    // 未下载区域
    html += `<div class="fav-group" style="${isFavMultiSelectMode ? 'opacity:0.9' : ''}">
        <div class="fav-sync-header" style="margin-bottom:10px">
            <span class="fav-sync-phase">📥 未下载 (${undownloaded.length})</span>
            ${(!isFavMultiSelectMode && favSyncedItems.length > 0) ? `
            <div style="display:flex;gap:8px;">
                <button class="btn btn--secondary" onclick="toggleFavMultiSelectMode()" style="padding:5px 12px;font-size:12px;border-radius:6px">多选</button>
                ${undownloaded.length > 0 ? `<button class="btn btn--sync" onclick="downloadAllFavItems()" style="padding:5px 12px;font-size:12px;border-radius:6px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span>全部下载</span>
                </button>` : ''}
            </div>` : ''}
        </div>`;

    if (undownloaded.length === 0) {
        html += '<div style="padding:12px 0;text-align:center;color:var(--c-text-muted);font-size:13px">🎉 全部已下载</div>';
    } else {
        html += '<div class="fav-sync-items">';
        html += undownloaded.map(item => renderFavItemCard(item, false)).join('');
        html += '</div>';
    }
    html += '</div>';

    // 已下载区域（可折叠）
    if (downloaded.length > 0) {
        html += `<div class="fav-group" style="margin-top:16px">
            <div class="fav-sync-header fav-downloaded-toggle" onclick="toggleDownloadedList()" style="cursor:pointer;margin-bottom:${favDownloadedExpanded ? '10' : '0'}px">
                <span class="fav-sync-phase" style="display:flex;align-items:center;gap:6px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"
                         style="transition:transform 0.2s;transform:rotate(${favDownloadedExpanded ? '90' : '0'}deg)">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                    ✅ 已下载 (${downloaded.length})
                </span>
                <span class="fav-sync-counter" style="font-size:11px;color:var(--c-text-muted)">点击${favDownloadedExpanded ? '收起' : '展开'}</span>
            </div>`;

        if (favDownloadedExpanded) {
            html += '<div class="fav-sync-items">';
            html += downloaded.map(item => renderFavItemCard(item, true)).join('');
            html += '</div>';
        }
        html += '</div>';
    }

    if (errored.length > 0) {
        html += '<div style="margin-top:12px">';
        html += errored.map(item => `<div class="fav-sync-item" style="opacity:0.5;padding:6px 12px">
            <svg class="fav-sync-item-status error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span class="fav-sync-item-title">${item.title} (解析失败)</span>
        </div>`).join('');
        html += '</div>';
    }

    panel.innerHTML = html;
}

function renderFavItemCard(item, isDownloadedSection) {
    const idx = item._idx;
    const coverHtml = item.cover
        ? `<img src="${item.cover}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
        : '';

    const dState = favDownloadStates[item.awemeId];
    const isDownloading = dState && dState.status === 'downloading';
    const isDownloaded = item.alreadyDownloaded || (dState && dState.status === 'done');
    const isError = dState && dState.status === 'error';

    let actionHtml = '';

    if (isDownloading) {
        const progress = dState.progress || 0;
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <div style="width:60px;height:4px;background:var(--c-border);border-radius:2px;overflow:hidden">
                <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,var(--c-primary),var(--c-accent));border-radius:2px;transition:width 0.3s"></div>
            </div>
            <span style="font-size:11px;color:var(--c-primary);font-family:var(--font-mono);white-space:nowrap">${progress}%</span>
        </div>`;
    } else if (isDownloadedSection && isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px;opacity:0.7" onclick="redownloadFavItem(${idx})" title="重新下载">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
            </button>
            <button class="action-btn action-btn--open" style="opacity:1" onclick="openFavFile(${idx})" title="打开文件夹">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
            </button>
            <button class="action-btn action-btn--delete" style="opacity:1" onclick="deleteFavFile(${idx})" title="删除文件">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>`;
    } else if (!isDownloaded) {
        actionHtml = `<button class="btn btn--primary" style="padding:5px 14px;font-size:12px;border-radius:8px;white-space:nowrap;flex-shrink:0" onclick="downloadFavItem(${idx})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>下载</span>
        </button>`;
    }

    if (isError && !isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <span style="font-size:11px;color:var(--c-error)">失败</span>
            <button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px" onclick="downloadFavItem(${idx})">重试</button>
        </div>`;
    }

    const authorHtml = item.author ? `<span style="font-size:11px;color:var(--c-text-muted)">@${item.author}</span>` : '';

    const isSelected = favSelectedItems.has(idx);
    const checkboxHtml = isFavMultiSelectMode ? `
        <div class="fav-checkbox-wrap">
            <input type="checkbox" class="fav-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleFavItemSelection(${idx})" />
        </div>
    ` : '';
    
    // 多选模式下隐藏操作按钮
    if (isFavMultiSelectMode) {
        actionHtml = '';
    }

    return `<div class="fav-sync-item ${isSelected ? 'selected' : ''}" style="padding:10px 12px;gap:10px;${isFavMultiSelectMode ? 'cursor:pointer;' : ''}" ${isFavMultiSelectMode ? `onclick="toggleFavItemSelection(${idx})"` : ''}>
        ${checkboxHtml}
        ${coverHtml}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
            <span class="fav-sync-item-title" title="${item.title}">${item.title}</span>
            ${authorHtml}
        </div>
        ${actionHtml}
    </div>`;
}

function toggleDownloadedList() {
    favDownloadedExpanded = !favDownloadedExpanded;
    renderFavList();
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
            title: item.title,
            awemeId: item.awemeId,
            platform: item.platform || 'douyin',
        });
        if (!result.taskId) throw new Error('No taskId');

        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                favDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    favDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    item.alreadyDownloaded = true;
                    renderFavList();
                    addToHistory({
                        fileName: task.fileName,
                        filePath: task.filePath,
                        fileSize: task.fileSize,
                        info: { title: item.title, cover: item.cover, type: item.type },
                    });
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    favDownloadStates[awemeId].status = 'error';
                    renderFavList();
                    showToast(`下载失败: ${task.error || '未知错误'}`, 'error');
                } else {
                    renderFavList();
                }
            } catch (e) { /* ignore */ }
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
    // 优先用下载状态中的路径，其次用同步 API 返回的路径
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
        // 从历史记录中也删掉
        let history = JSON.parse(localStorage.getItem('dy_history') || '[]');
        history = history.filter(h => h.filePath !== fp);
        localStorage.setItem('dy_history', JSON.stringify(history));
        loadHistory();
    } catch (err) {
        if (err.message.includes('不存在')) {
            showToast('文件已经不存在了', 'info');
        } else {
            showToast('删除失败: ' + err.message, 'error');
            return;
        }
    }
    // 标记为未下载状态
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

// ── 多选下载逻辑 ──
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
    toggleFavMultiSelectMode(); // 退出多选模式，开始依次下载
    
    for (const idx of targets) {
        const item = favSyncedItems[idx];
        if (!item || item.parseError) continue;
        const ds = favDownloadStates[item.awemeId];
        // 如果正在下或已下完，则跳过
        if (ds && (ds.status === 'downloading' || ds.status === 'done')) continue;
        await downloadFavItem(idx);
    }
}

// ═══════════════════════════════════════════
// 喜欢同步
// ═══════════════════════════════════════════

let likedSyncPollTimer = null;
let likedSyncedItems = [];
let likedDownloadStates = {};
let isLikedMultiSelectMode = false;
let likedSelectedItems = new Set();
let likedDownloadedExpanded = false;

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
    if (status.loggedIn) {
        syncBtn.disabled = false;
    } else {
        syncBtn.disabled = true;
    }
}

async function handleLikedSync() {
    const syncBtn = document.getElementById('likedSyncBtn');
    const maxCount = parseInt(document.getElementById('likedMaxCount').value) || 50;
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        syncBtn.querySelector('.btn-label').textContent = '同步中 . . .';

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
        syncBtn.querySelector('.btn-label').textContent = '同步喜欢';
    }
}

function pollLikedSync(taskId) {
    const panel = document.getElementById('likedSyncPanel');
    panel.style.display = 'block';

    if (likedSyncPollTimer) clearInterval(likedSyncPollTimer);

    likedSyncPollTimer = setInterval(async () => {
        try {
            const task = await api('GET', `/api/liked/sync/${taskId}`);

            if (task.status === 'fetching') {
                panel.innerHTML = `
                    <div class="fav-sync-header">
                        <div>
                            <span class="fav-sync-phase">${task.phase || '正在获取喜欢列表...'}</span>
                            <span class="fav-sync-counter" style="margin-left:8px">已发现 ${task.collected || 0} 条</span>
                        </div>
                        <button class="btn btn--stop" style="padding:4px 10px;font-size:11px;border-radius:6px;color:white;border:none;cursor:pointer;" onclick="stopLikedSync('${taskId}')">停止打断</button>
                    </div>
                    <div class="fav-sync-progress">
                        <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                    </div>
                `;
            } else if (task.status === 'done' || task.status === 'error') {
                clearInterval(likedSyncPollTimer);
                likedSyncPollTimer = null;

                const syncBtn = document.getElementById('likedSyncBtn');
                syncBtn.classList.remove('syncing');
                syncBtn.disabled = false;
                syncBtn.querySelector('.btn-label').textContent = '同步喜欢';
                loadLikedStatus();

                if (task.status === 'error') {
                    panel.innerHTML = `<div class="fav-login-hint" style="color:var(--c-error)">❌ ${task.error || '获取失败'}</div>`;
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

function renderLikedList() {
    const panel = document.getElementById('likedSyncPanel');
    if (!likedSyncedItems || likedSyncedItems.length === 0) {
        panel.innerHTML = '<div class="fav-login-hint">喜欢列表为空</div>';
        return;
    }

    const undownloaded = [];
    const downloaded = [];
    const errored = [];

    likedSyncedItems.forEach((item, idx) => {
        item._idx = idx;
        if (item.parseError) {
            errored.push(item);
        } else {
            const ds = likedDownloadStates[item.awemeId];
            const isDone = item.alreadyDownloaded || (ds && ds.status === 'done');
            if (isDone) {
                downloaded.push(item);
            } else {
                undownloaded.push(item);
            }
        }
    });

    let html = '';

    if (isLikedMultiSelectMode) {
        html += `<div class="multi-select-bar">
            <span style="font-size:13px;font-weight:600;color:var(--c-primary)">已选 ${likedSelectedItems.size} 项</span>
            <div class="multi-select-actions">
                <button class="btn btn--secondary" style="padding:5px 10px;font-size:12px;border-radius:6px" onclick="likedSelectAllUndownloaded()">全选未下载</button>
                <button class="btn btn--secondary" style="padding:5px 10px;font-size:12px;border-radius:6px" onclick="toggleLikedMultiSelectMode()">取消</button>
                <button class="btn btn--sync" style="padding:5px 12px;font-size:12px;border-radius:6px" onclick="downloadSelectedLikedItems()" ${likedSelectedItems.size === 0 ? 'disabled' : ''}>下载所选</button>
            </div>
        </div>`;
    }

    html += `<div class="fav-group" style="${isLikedMultiSelectMode ? 'opacity:0.9' : ''}">
        <div class="fav-sync-header" style="margin-bottom:10px">
            <span class="fav-sync-phase">📥 未下载 (${undownloaded.length})</span>
            ${(!isLikedMultiSelectMode && likedSyncedItems.length > 0) ? `
            <div style="display:flex;gap:8px;">
                <button class="btn btn--secondary" onclick="toggleLikedMultiSelectMode()" style="padding:5px 12px;font-size:12px;border-radius:6px">多选</button>
                ${undownloaded.length > 0 ? `<button class="btn btn--sync" onclick="downloadAllLikedItems()" style="padding:5px 12px;font-size:12px;border-radius:6px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span>全部下载</span>
                </button>` : ''}
            </div>` : ''}
        </div>`;

    if (undownloaded.length === 0) {
        html += '<div style="padding:12px 0;text-align:center;color:var(--c-text-muted);font-size:13px">🎉 全部已下载</div>';
    } else {
        html += '<div class="fav-sync-items">';
        html += undownloaded.map(item => renderLikedItemCard(item, false)).join('');
        html += '</div>';
    }
    html += '</div>';

    if (downloaded.length > 0) {
        html += `<div class="fav-group" style="margin-top:16px">
            <div class="fav-sync-header fav-downloaded-toggle" onclick="toggleLikedDownloadedList()" style="cursor:pointer;margin-bottom:${likedDownloadedExpanded ? '10' : '0'}px">
                <span class="fav-sync-phase" style="display:flex;align-items:center;gap:6px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"
                         style="transition:transform 0.2s;transform:rotate(${likedDownloadedExpanded ? '90' : '0'}deg)">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                    ✅ 已下载 (${downloaded.length})
                </span>
                <span class="fav-sync-counter" style="font-size:11px;color:var(--c-text-muted)">点击${likedDownloadedExpanded ? '收起' : '展开'}</span>
            </div>`;

        if (likedDownloadedExpanded) {
            html += '<div class="fav-sync-items">';
            html += downloaded.map(item => renderLikedItemCard(item, true)).join('');
            html += '</div>';
        }
        html += '</div>';
    }

    if (errored.length > 0) {
        html += '<div style="margin-top:12px">';
        html += errored.map(item => `<div class="fav-sync-item" style="opacity:0.5;padding:6px 12px">
            <svg class="fav-sync-item-status error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span class="fav-sync-item-title">${item.title} (解析失败)</span>
        </div>`).join('');
        html += '</div>';
    }

    panel.innerHTML = html;
}

function renderLikedItemCard(item, isDownloadedSection) {
    const idx = item._idx;
    const coverHtml = item.cover
        ? `<img src="${item.cover}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
        : '';

    const dState = likedDownloadStates[item.awemeId];
    const isDownloading = dState && dState.status === 'downloading';
    const isDownloaded = item.alreadyDownloaded || (dState && dState.status === 'done');
    const isError = dState && dState.status === 'error';

    let actionHtml = '';

    if (isDownloading) {
        const progress = dState.progress || 0;
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <div style="width:60px;height:4px;background:var(--c-border);border-radius:2px;overflow:hidden">
                <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,var(--c-primary),var(--c-accent));border-radius:2px;transition:width 0.3s"></div>
            </div>
            <span style="font-size:11px;color:var(--c-primary);font-family:var(--font-mono);white-space:nowrap">${progress}%</span>
        </div>`;
    } else if (isDownloadedSection && isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px;opacity:0.7" onclick="redownloadLikedItem(${idx})" title="重新下载">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
            </button>
            <button class="action-btn action-btn--open" style="opacity:1" onclick="openLikedFile(${idx})" title="打开文件夹">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
            </button>
            <button class="action-btn action-btn--delete" style="opacity:1" onclick="deleteLikedFile(${idx})" title="删除文件">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>`;
    } else if (!isDownloaded) {
        actionHtml = `<button class="btn btn--primary" style="padding:5px 14px;font-size:12px;border-radius:8px;white-space:nowrap;flex-shrink:0" onclick="downloadLikedItem(${idx})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>下载</span>
        </button>`;
    }

    if (isError && !isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <span style="font-size:11px;color:var(--c-error)">失败</span>
            <button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px" onclick="downloadLikedItem(${idx})">重试</button>
        </div>`;
    }

    const authorHtml = item.author ? `<span style="font-size:11px;color:var(--c-text-muted)">@${item.author}</span>` : '';

    const isSelected = likedSelectedItems.has(idx);
    const checkboxHtml = isLikedMultiSelectMode ? `
        <div class="fav-checkbox-wrap">
            <input type="checkbox" class="fav-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleLikedItemSelection(${idx})" />
        </div>
    ` : '';
    
    if (isLikedMultiSelectMode) {
        actionHtml = '';
    }

    return `<div class="fav-sync-item ${isSelected ? 'selected' : ''}" style="padding:10px 12px;gap:10px;${isLikedMultiSelectMode ? 'cursor:pointer;' : ''}" ${isLikedMultiSelectMode ? `onclick="toggleLikedItemSelection(${idx})"` : ''}>
        ${checkboxHtml}
        ${coverHtml}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
            <span class="fav-sync-item-title" title="${item.title}">${item.title}</span>
            ${authorHtml}
        </div>
        ${actionHtml}
    </div>`;
}

function toggleLikedDownloadedList() {
    likedDownloadedExpanded = !likedDownloadedExpanded;
    renderLikedList();
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
            title: item.title,
            awemeId: item.awemeId,
            platform: item.platform || 'douyin',
        });
        if (!result.taskId) throw new Error('No taskId');

        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                likedDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    likedDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    item.alreadyDownloaded = true;
                    renderLikedList();
                    addToHistory({
                        fileName: task.fileName,
                        filePath: task.filePath,
                        fileSize: task.fileSize,
                        info: { title: item.title, cover: item.cover, type: item.type },
                    });
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    likedDownloadStates[awemeId].status = 'error';
                    renderLikedList();
                    showToast(`下载失败: ${task.error || '未知错误'}`, 'error');
                } else {
                    renderLikedList();
                }
            } catch (e) { /* ignore */ }
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
        let history = JSON.parse(localStorage.getItem('dy_history') || '[]');
        history = history.filter(h => h.filePath !== fp);
        localStorage.setItem('dy_history', JSON.stringify(history));
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

let msgSyncPollTimer = null;
let msgSyncedItems = [];
let msgDownloadStates = {};
let isMsgMultiSelectMode = false;
let msgSelectedItems = new Set();
let msgDownloadedExpanded = false;

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
    const maxCount = parseInt(document.getElementById('msgMaxCount').value) || 50;
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        syncBtn.querySelector('.btn-label').textContent = '同步中 . . .';

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
        syncBtn.querySelector('.btn-label').textContent = '同步私信';
    }
}

function pollMsgSync(taskId) {
    const panel = document.getElementById('msgSyncPanel');
    panel.style.display = 'block';

    if (msgSyncPollTimer) clearInterval(msgSyncPollTimer);

    msgSyncPollTimer = setInterval(async () => {
        try {
            const task = await api('GET', `/api/messages/sync/${taskId}`);

            if (task.status === 'fetching') {
                panel.innerHTML = `
                    <div class="fav-sync-header">
                        <div>
                            <span class="fav-sync-phase">${task.phase || '正在扫描私信...'}</span>
                            <span class="fav-sync-counter" style="margin-left:8px">已发现 ${task.collected || 0} 条</span>
                        </div>
                        <button class="btn btn--stop" style="padding:4px 10px;font-size:11px;border-radius:6px;color:white;border:none;cursor:pointer;" onclick="stopMsgSync('${taskId}')">停止打断</button>
                    </div>
                    <div class="fav-sync-progress">
                        <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                    </div>
                `;
            } else if (task.status === 'done' || task.status === 'error') {
                clearInterval(msgSyncPollTimer);
                msgSyncPollTimer = null;

                const syncBtn = document.getElementById('msgSyncBtn');
                syncBtn.classList.remove('syncing');
                syncBtn.disabled = false;
                syncBtn.querySelector('.btn-label').textContent = '同步私信';
                loadMsgStatus();

                if (task.status === 'error') {
                    panel.innerHTML = `<div class="fav-login-hint" style="color:var(--c-error)">❌ ${task.error || '获取失败'}</div>`;
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

function renderMsgList() {
    const panel = document.getElementById('msgSyncPanel');
    if (!msgSyncedItems || msgSyncedItems.length === 0) {
        panel.innerHTML = '<div class="fav-login-hint">未在私信中发现视频链接</div>';
        return;
    }

    const undownloaded = [];
    const downloaded = [];
    const errored = [];

    msgSyncedItems.forEach((item, idx) => {
        item._idx = idx;
        if (item.parseError) {
            errored.push(item);
        } else {
            const ds = msgDownloadStates[item.awemeId];
            const isDone = item.alreadyDownloaded || (ds && ds.status === 'done');
            if (isDone) {
                downloaded.push(item);
            } else {
                undownloaded.push(item);
            }
        }
    });

    let html = '';

    if (isMsgMultiSelectMode) {
        html += `<div class="multi-select-bar">
            <span style="font-size:13px;font-weight:600;color:var(--c-primary)">已选 ${msgSelectedItems.size} 项</span>
            <div class="multi-select-actions">
                <button class="btn btn--secondary" style="padding:5px 10px;font-size:12px;border-radius:6px" onclick="msgSelectAllUndownloaded()">全选未下载</button>
                <button class="btn btn--secondary" style="padding:5px 10px;font-size:12px;border-radius:6px" onclick="toggleMsgMultiSelectMode()">取消</button>
                <button class="btn btn--sync" style="padding:5px 12px;font-size:12px;border-radius:6px" onclick="downloadSelectedMsgItems()" ${msgSelectedItems.size === 0 ? 'disabled' : ''}>下载所选</button>
            </div>
        </div>`;
    }

    html += `<div class="fav-group" style="${isMsgMultiSelectMode ? 'opacity:0.9' : ''}">
        <div class="fav-sync-header" style="margin-bottom:10px">
            <span class="fav-sync-phase">📥 未下载 (${undownloaded.length})</span>
            ${(!isMsgMultiSelectMode && msgSyncedItems.length > 0) ? `
            <div style="display:flex;gap:8px;">
                <button class="btn btn--secondary" onclick="toggleMsgMultiSelectMode()" style="padding:5px 12px;font-size:12px;border-radius:6px">多选</button>
                ${undownloaded.length > 0 ? `<button class="btn btn--sync" onclick="downloadAllMsgItems()" style="padding:5px 12px;font-size:12px;border-radius:6px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span>全部下载</span>
                </button>` : ''}
            </div>` : ''}
        </div>`;

    if (undownloaded.length === 0) {
        html += '<div style="padding:12px 0;text-align:center;color:var(--c-text-muted);font-size:13px">🎉 全部已下载</div>';
    } else {
        html += '<div class="fav-sync-items">';
        html += undownloaded.map(item => renderMsgItemCard(item, false)).join('');
        html += '</div>';
    }
    html += '</div>';

    if (downloaded.length > 0) {
        html += `<div class="fav-group" style="margin-top:16px">
            <div class="fav-sync-header fav-downloaded-toggle" onclick="toggleMsgDownloadedList()" style="cursor:pointer;margin-bottom:${msgDownloadedExpanded ? '10' : '0'}px">
                <span class="fav-sync-phase" style="display:flex;align-items:center;gap:6px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"
                         style="transition:transform 0.2s;transform:rotate(${msgDownloadedExpanded ? '90' : '0'}deg)">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                    ✅ 已下载 (${downloaded.length})
                </span>
                <span class="fav-sync-counter" style="font-size:11px;color:var(--c-text-muted)">点击${msgDownloadedExpanded ? '收起' : '展开'}</span>
            </div>`;

        if (msgDownloadedExpanded) {
            html += '<div class="fav-sync-items">';
            html += downloaded.map(item => renderMsgItemCard(item, true)).join('');
            html += '</div>';
        }
        html += '</div>';
    }

    if (errored.length > 0) {
        html += '<div style="margin-top:12px">';
        html += errored.map(item => `<div class="fav-sync-item" style="opacity:0.5;padding:6px 12px">
            <svg class="fav-sync-item-status error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span class="fav-sync-item-title">${item.title} (解析失败)</span>
        </div>`).join('');
        html += '</div>';
    }

    panel.innerHTML = html;
}

function renderMsgItemCard(item, isDownloadedSection) {
    const idx = item._idx;
    const coverHtml = item.cover
        ? `<img src="${item.cover}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
        : '';

    const dState = msgDownloadStates[item.awemeId];
    const isDownloading = dState && dState.status === 'downloading';
    const isDownloaded = item.alreadyDownloaded || (dState && dState.status === 'done');
    const isError = dState && dState.status === 'error';

    let actionHtml = '';

    if (isDownloading) {
        const progress = dState.progress || 0;
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <div style="width:60px;height:4px;background:var(--c-border);border-radius:2px;overflow:hidden">
                <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,var(--c-primary),var(--c-accent));border-radius:2px;transition:width 0.3s"></div>
            </div>
            <span style="font-size:11px;color:var(--c-primary);font-family:var(--font-mono);white-space:nowrap">${progress}%</span>
        </div>`;
    } else if (isDownloadedSection && isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px;opacity:0.7" onclick="redownloadMsgItem(${idx})" title="重新下载">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
            </button>
            <button class="action-btn action-btn--open" style="opacity:1" onclick="openMsgFile(${idx})" title="打开文件夹">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
            </button>
            <button class="action-btn action-btn--delete" style="opacity:1" onclick="deleteMsgFile(${idx})" title="删除文件">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>`;
    } else if (!isDownloaded) {
        actionHtml = `<button class="btn btn--primary" style="padding:5px 14px;font-size:12px;border-radius:8px;white-space:nowrap;flex-shrink:0" onclick="downloadMsgItem(${idx})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>下载</span>
        </button>`;
    }

    if (isError && !isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <span style="font-size:11px;color:var(--c-error)">失败</span>
            <button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px" onclick="downloadMsgItem(${idx})">重试</button>
        </div>`;
    }

    const authorHtml = item.author ? `<span style="font-size:11px;color:var(--c-text-muted)">@${item.author}</span>` : '';

    const isSelected = msgSelectedItems.has(idx);
    const checkboxHtml = isMsgMultiSelectMode ? `
        <div class="fav-checkbox-wrap">
            <input type="checkbox" class="fav-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleMsgItemSelection(${idx})" />
        </div>
    ` : '';

    if (isMsgMultiSelectMode) {
        actionHtml = '';
    }

    return `<div class="fav-sync-item ${isSelected ? 'selected' : ''}" style="padding:10px 12px;gap:10px;${isMsgMultiSelectMode ? 'cursor:pointer;' : ''}" ${isMsgMultiSelectMode ? `onclick="toggleMsgItemSelection(${idx})"` : ''}>
        ${checkboxHtml}
        ${coverHtml}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
            <span class="fav-sync-item-title" title="${item.title}">${item.title}</span>
            ${authorHtml}
        </div>
        ${actionHtml}
    </div>`;
}

function toggleMsgDownloadedList() {
    msgDownloadedExpanded = !msgDownloadedExpanded;
    renderMsgList();
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
            title: item.title,
            awemeId: item.awemeId,
            platform: item.platform || 'douyin',
        });
        if (!result.taskId) throw new Error('No taskId');

        const pollId = setInterval(async () => {
            try {
                const task = await api('GET', `/api/download/${result.taskId}`);
                msgDownloadStates[awemeId].progress = task.progress || 0;

                if (task.status === 'done') {
                    clearInterval(pollId);
                    msgDownloadStates[awemeId] = { status: 'done', filePath: task.filePath, fileName: task.fileName, fileSize: task.fileSize };
                    item.alreadyDownloaded = true;
                    renderMsgList();
                    addToHistory({
                        fileName: task.fileName,
                        filePath: task.filePath,
                        fileSize: task.fileSize,
                        info: { title: item.title, cover: item.cover, type: item.type },
                    });
                    loadHistory();
                } else if (task.status === 'error') {
                    clearInterval(pollId);
                    msgDownloadStates[awemeId].status = 'error';
                    renderMsgList();
                    showToast(`下载失败: ${task.error || '未知错误'}`, 'error');
                } else {
                    renderMsgList();
                }
            } catch (e) { /* ignore */ }
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
        let history = JSON.parse(localStorage.getItem('dy_history') || '[]');
        history = history.filter(h => h.filePath !== fp);
        localStorage.setItem('dy_history', JSON.stringify(history));
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
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') {
        loadScheduleConfig();
    }
}

async function loadScheduleConfig() {
    try {
        const cfg = await api('GET', '/api/schedule/config');
        document.getElementById('scheduleEnabled').checked = cfg.enabled;
        document.getElementById('scheduleSyncMode').value = cfg.syncMode || 'both';
        document.getElementById('scheduleMaxCount').value = cfg.maxCount || 50;

        // 将 cron 表达式转为 HH:MM 时间展示
        const cronParts = (cfg.cronTime || '0 0 * * *').split(' ');
        const hour = (cronParts[1] || '0').padStart(2, '0');
        const minute = (cronParts[0] || '0').padStart(2, '0');
        document.getElementById('scheduleTime').value = `${hour}:${minute}`;

        // 随机触发模式
        const triggerMode = cfg.triggerMode || 'fixed';
        document.getElementById('scheduleTriggerMode').value = triggerMode;
        document.getElementById('scheduleRangeStart').value = cfg.rangeStart || '00:00';
        document.getElementById('scheduleRangeEnd').value = cfg.rangeEnd || '06:00';
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

// ── 定时触发模式切换 ──
function onTriggerModeChange() {
    const mode = document.getElementById('scheduleTriggerMode').value;
    document.getElementById('scheduleFixedRow').style.display = mode === 'fixed' ? 'flex' : 'none';
    document.getElementById('scheduleRandomRow').style.display = mode === 'random' ? 'flex' : 'none';
}

async function saveScheduleConfig() {
    const enabled = document.getElementById('scheduleEnabled').checked;
    const triggerMode = document.getElementById('scheduleTriggerMode').value;
    const timeVal = document.getElementById('scheduleTime').value || '00:00';
    const syncMode = document.getElementById('scheduleSyncMode').value;
    const maxCount = parseInt(document.getElementById('scheduleMaxCount').value) || 50;
    const rangeStart = document.getElementById('scheduleRangeStart').value || '00:00';
    const rangeEnd = document.getElementById('scheduleRangeEnd').value || '06:00';

    // 固定模式使用 cron，随机模式使用 range
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
            const modeLabel = { both: '收藏+喜欢', favorites: '仅收藏', liked: '仅喜欢' }[log.syncMode] || log.syncMode;
            if (log.error) {
                return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);">
                    <span style="color:var(--c-error);">✕</span> ${time} [${modeLabel}] ${log.error}
                </div>`;
            }
            const r = log.results || {};
            return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);">
                <span style="color:var(--c-success);">✓</span> ${time} [${modeLabel}] 发现${log.totalFound || 0}条 → 下载${log.toDownload || 0}条 (成功${r.success || 0} / 失败${r.fail || 0})
            </div>`;
        }).join('');
    } catch (err) {
        logPanel.innerHTML = `<div style="color:var(--c-error);">加载失败: ${err.message}</div>`;
    }
}

// 页面加载时初始化定时同步状态
document.addEventListener('DOMContentLoaded', () => {
    loadScheduleConfig();
});
