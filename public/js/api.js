/* ═══════════════════════════════════════════
   抖音视频下载器 — API 交互与基础工具库
   ═══════════════════════════════════════════ */

// ── API 封装 ──
function getApiToken() {
    return window.localStorage.getItem('api_token') || '';
}

function setApiToken(token) {
    const value = (token || '').trim();
    if (value) {
        window.localStorage.setItem('api_token', value);
    } else {
        window.localStorage.removeItem('api_token');
    }
}

async function api(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getApiToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const options = {
        method,
        headers,
    };
    if (body) options.body = JSON.stringify(body);

    const resp = await fetch(url, options);
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await resp.json() : null;
    const text = isJson ? '' : await resp.text();

    if (!resp.ok) {
        throw new Error((data && data.error) || text || `请求失败 (${resp.status})`);
    }
    return data;
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

// ── 错误展示 ──
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

// ── 加载状态 ──
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

// ── 字节格式化 ──
function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
