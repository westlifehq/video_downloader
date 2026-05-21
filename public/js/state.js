/* ═══════════════════════════════════════════
   抖音视频下载器 — 全局状态与滚动记忆管理
   ═══════════════════════════════════════════ */

// ── 全局状态 ──
let appState = {
    items: {}, // key: id, value: { url, info, loading, error, status, progress, total, downloaded, fileSize, taskId, fileName, downloadError }
    pollTimers: {} // key: id, value: interval timer
};

// ── 绝对路径安全 ID 映射与 HTML 转义机制 ──
const pathIdMap = new Map();

function registerPath(filePath) {
    if (!filePath) return '';
    const id = 'path_' + Math.random().toString(36).substring(2, 11);
    pathIdMap.set(id, filePath);
    return id;
}

function getPathById(id) {
    return pathIdMap.get(id) || '';
}

window.openHistoryFileById = function(id) {
    if (typeof openHistoryFile === 'function') {
        openHistoryFile(getPathById(id));
    } else {
        console.error('openHistoryFile not defined yet');
    }
};

window.deleteHistoryFileById = function(id, realIndex) {
    if (typeof deleteHistoryFile === 'function') {
        deleteHistoryFile(getPathById(id), realIndex);
    } else {
        console.error('deleteHistoryFile not defined yet');
    }
};

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── 辅助函数：替换 innerHTML 并在渲染前后恢复滚动位置 ──
function setHtmlAndRestoreScroll(el, html) {
    if (!el) return;

    // 1. 记录 window 滚动位置
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    // 2. 记录内部所有可滚动元素的滚动偏移，通过 .fav-sync-header 前几个字符作为标识键，保证准确匹配
    const scrollStates = [];
    const scrollableEls = el.querySelectorAll('.fav-sync-items, [style*="overflow"], textarea, div');
    scrollableEls.forEach(scrollEl => {
        if (scrollEl.scrollTop > 0 || scrollEl.scrollLeft > 0) {
            const groupEl = scrollEl.closest('.fav-group');
            let key = '';
            if (groupEl) {
                const header = groupEl.querySelector('.fav-sync-header');
                if (header) {
                    key = header.textContent.trim().substring(0, 6);
                }
            }
            scrollStates.push({
                scrollTop: scrollEl.scrollTop,
                scrollLeft: scrollEl.scrollLeft,
                className: scrollEl.className,
                key: key
            });
        }
    });

    // 3. 赋值 HTML
    el.innerHTML = html;

    // 4. 恢复内部可滚动元素的滚动偏移
    const newScrollableEls = el.querySelectorAll('.fav-sync-items, [style*="overflow"], textarea, div');
    newScrollableEls.forEach(newScrollEl => {
        const groupEl = newScrollEl.closest('.fav-group');
        let key = '';
        if (groupEl) {
            const header = groupEl.querySelector('.fav-sync-header');
            if (header) {
                key = header.textContent.trim().substring(0, 6);
            }
        }
        const state = scrollStates.find(s => s.className === newScrollEl.className && s.key === key);
        if (state) {
            newScrollEl.scrollTop = state.scrollTop;
            newScrollEl.scrollLeft = state.scrollLeft;
        }
    });

    // 5. 恢复 window 滚动位置
    window.scrollTo(scrollX, scrollY);
}
