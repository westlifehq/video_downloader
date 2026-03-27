/* ═══════════════════════════════════════════
   抖音视频下载器 — 前端逻辑 (重构以支持多任务与图文)
   ═══════════════════════════════════════════ */

// ── 全局状态 ──
let appState = {
    items: {}, // key: id, value: { url, info, loading, error, status, progress, total, downloaded, fileSize, taskId, fileName, downloadError }
    pollTimers: {} // key: id, value: interval timer
};

// ── 远程模式检测（非 localhost 即为远程/Docker 部署模式）──
function isRemoteMode() {
    const h = location.hostname;
    return h !== 'localhost' && h !== '127.0.0.1';
}

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    loadHistory();

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

        // 下载完成后显示「保存到手机」按钮
        let saveToPhoneHtml = '';
        if (item.status === 'done' && item.taskId) {
            // 在 URL 结尾拼上文件名，解决夸克/UC浏览器将其保存为 .vdat 且无后缀的问题
            const safeName = encodeURIComponent(item.fileName || 'video.mp4');
            saveToPhoneHtml = `
              <a class="btn btn--save-phone" href="/api/file/${item.taskId}/${safeName}" download="${item.fileName || ''}" style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:8px 16px;background:var(--c-primary);color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                保存到手机
              </a>`;
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
            ${saveToPhoneHtml}
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
    const typeLabel = item.info.type === 'image' ? '图文' : '视频';
    if (isRemoteMode()) {
        showToast(`${typeLabel}已保存到服务器，点击「保存到手机」可下载到本地`, 'success');
    } else {
        showToast(`${typeLabel}下载完成！`, 'success');
    }
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
    const remote = isRemoteMode();
    list.innerHTML = history.map((item, index) => {
        const thumbHtml = buildThumbHtml(item.cover);
        const escapedPath = (item.filePath || '').replace(/\\/g, '\\\\');
        const deleteTitle = remote ? '从服务器删除' : '从磁盘删除文件';

        const openBtn = remote ? '' : `
          <button class="action-btn action-btn--open" onclick="openHistoryFile('${escapedPath}')" title="在文件夹中显示">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>`;

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
          ${openBtn}
          <button class="action-btn action-btn--delete" onclick="deleteHistoryFile('${escapedPath}', ${index})" title="${deleteTitle}">
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

function buildThumbHtml(cover) {
    const placeholder = '<div class="history-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div>';
    if (!cover) return placeholder;
    return `<img class="history-thumb" src="${cover}" alt="" onerror="this.outerHTML='${placeholder.replace(/'/g, "\\'")}'">`;
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
        // 无论物理删除是否成功（只要接口跑了），都从历史记录中清理
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
