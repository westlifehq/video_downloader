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
        fileName: item.fileName,
        filePath: item.filePath,
        fileSize: item.fileSize,
        cover: item.info ? item.info.cover : '',
        time: Date.now(),
    });
    history = history.slice(0, 50);
    localStorage.setItem('dy_history', JSON.stringify(history));
}

function loadHistory() {
    const history = JSON.parse(localStorage.getItem('dy_history') || '[]');
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');

    if (history.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = history.map((item, index) => {
        const placeholderHtml = `<div class="history-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`;
        const thumbHtml = item.cover
            ? `<img class="history-thumb" src="${item.cover}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">` + `<div class="history-thumb-placeholder" style="display:none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>`
            : placeholderHtml;
        return `
      <div class="history-item">
        ${thumbHtml}
        <div class="history-info">
          <span class="history-name" title="${item.filePath || ''}">${item.title || item.fileName}</span>
          <div class="history-meta">
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
          <button class="action-btn action-btn--delete" onclick="deleteHistoryFile('${(item.filePath || '').replace(/\\/g, '\\\\')}', ${index})" title="从磁盘删除文件">
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
    } catch (err) {
        console.error('加载收藏状态失败:', err);
    }
}

function updateFavUI(status) {
    const badge = document.getElementById('favAccountBadge');
    const accountBtn = document.getElementById('favAccountBtn');
    const accountBtnText = document.getElementById('favAccountBtnText');
    const syncBtn = document.getElementById('favSyncBtn');

    if (status.loggedIn) {
        badge.style.display = 'inline-flex';
        document.getElementById('favAccountText').textContent =
            status.lastSyncTime ? `上次同步 ${formatSyncTime(status.lastSyncTime)}` : '已登录';
        accountBtn.className = 'btn btn--account logged-in';
        accountBtnText.textContent = '切换账号';
        syncBtn.disabled = false;
    } else {
        badge.style.display = 'none';
        accountBtn.className = 'btn btn--account';
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
        if (!confirm('退出当前抖音账号？退出后可重新扫码登录其他账号。')) return;
        try {
            await api('POST', '/api/favorites/logout');
            showToast('已退出登录', 'success');
            favIsLoggedIn = false;
            updateFavUI({ loggedIn: false });
            document.getElementById('favSyncPanel').style.display = 'none';
            favSyncedItems = [];
        } catch (err) {
            showToast('退出失败: ' + err.message, 'error');
        }
    } else {
        try {
            await api('POST', '/api/favorites/login');
            showToast('浏览器已打开，请在弹出的窗口中扫码登录', 'success');

            if (favLoginPollTimer) clearInterval(favLoginPollTimer);
            const panel = document.getElementById('favSyncPanel');
            panel.style.display = 'block';
            panel.innerHTML = `
                <div class="fav-login-hint">
                    <div class="hint-icon">📱</div>
                    <div>请在弹出的浏览器窗口中用抖音 App 扫码登录</div>
                    <div style="margin-top:8px; font-size:11px; color:var(--c-text-muted)">登录成功后窗口会自动关闭</div>
                </div>
            `;

            favLoginPollTimer = setInterval(async () => {
                try {
                    const status = await api('GET', '/api/favorites/status');
                    if (status.loggedIn) {
                        clearInterval(favLoginPollTimer);
                        favLoginPollTimer = null;
                        favIsLoggedIn = true;
                        updateFavUI(status);
                        panel.style.display = 'none';
                        showToast('登录成功！现在可以同步收藏了', 'success');
                    }
                } catch (e) { /* ignore */ }
            }, 2000);

            setTimeout(() => {
                if (favLoginPollTimer) {
                    clearInterval(favLoginPollTimer);
                    favLoginPollTimer = null;
                    panel.style.display = 'none';
                }
            }, 5 * 60 * 1000);
        } catch (err) {
            showToast('打开登录窗口失败: ' + err.message, 'error');
        }
    }
}

/**
 * 同步收藏按钮：只拉取列表，不自动下载
 */
async function handleFavoritesSync() {
    const syncBtn = document.getElementById('favSyncBtn');
    try {
        syncBtn.classList.add('syncing');
        syncBtn.disabled = true;
        syncBtn.querySelector('span').textContent = '同步中...';

        const result = await api('POST', '/api/favorites/sync', { maxCount: 50 });
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
        syncBtn.querySelector('span').textContent = '同步收藏';
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
                syncBtn.querySelector('span').textContent = '同步收藏';
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
