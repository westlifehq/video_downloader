/* ═══════════════════════════════════════════
   抖音视频下载器 — DOM 渲染与模板生成模块
   ═══════════════════════════════════════════ */

let favDownloadedExpanded = false;
let likedDownloadedExpanded = false;
let msgDownloadedExpanded = false;

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

// ── 卡片占位符 ──
function appendCardPlaceHolder(id) {
    const container = document.getElementById('resultsContainer');
    const div = document.createElement('div');
    div.id = id;
    div.className = 'video-info';
    container.appendChild(div);
    updateCard(id);
}

// ── 更新主解析卡片 ──
function updateCard(id) {
    const item = appState.items[id];
    const el = document.getElementById(id);
    if (!el) return;

    if (item.loading) {
        setHtmlAndRestoreScroll(el, `
            <div class="video-card" style="justify-content:center; padding:30px;">
                <div class="btn-loader" style="display:block; border-top-color:var(--c-primary); width:24px; height:24px;"></div>
                <div style="margin-left:12px; color:var(--c-text-muted); font-size:14px;">解析中...</div>
            </div>`);
        return;
    }

    if (item.error) {
        setHtmlAndRestoreScroll(el, `
            <div class="video-card" style="border-color: rgba(248, 113, 113, 0.4);">
                <div class="video-meta">
                    <p style="color:var(--c-error); font-weight:500;">解析失败: ${escapeHTML(item.error)}</p>
                    <p style="font-size:12px; color:var(--c-text-muted); margin-top:8px; word-break:break-all;">${escapeHTML(item.url)}</p>
                </div>
            </div>`);
        return;
    }

    const info = item.info;

    // 如果是用户主页类型，使用专用用户卡片渲染
    if (info.type === 'user') {
        if (item.syncStatus === undefined) {
            item.syncStatus = 'idle'; // idle, fetching, done, error
            item.syncPhase = '';
            item.syncCollected = 0;
            item.syncMaxCount = 50;
            item.syncTaskId = '';
            item.userItems = [];
            item.userDownloadStates = {};
            item.isMultiSelectMode = false;
            item.selectedItems = new Set();
            item.downloadedExpanded = false;
        }

        if (item.syncStatus === 'idle') {
            if (item.syncType === undefined) {
                item.syncType = 'post';
            }
            setHtmlAndRestoreScroll(el, `
              <div class="video-card user-sync-card" style="flex-direction:column; align-items:stretch;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="author-avatar" style="width:36px; height:36px; border-radius:50%; background:var(--c-primary); display:flex; align-items:center; justify-content:center; font-weight:bold; color:white; font-size:18px;">👤</div>
                    <div>
                      <h3 style="font-size:15px; font-weight:600; color:white; margin:0;">${escapeHTML(item.nickname || info.author?.nickname || '抖音用户')}</h3>
                      <p style="font-size:12px; color:var(--c-text-muted); margin:0;">检测到这是一个抖音用户主页，可以同步并批量下载其作品或公开喜欢视频。</p>
                    </div>
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <select id="user-sync-type-${id}" class="select-field" style="width:110px; display:inline-block; height:36px; padding:0 8px; border-radius:6px; background:rgba(255,255,255,0.05); color:white; border:1px solid rgba(255,255,255,0.1);" onchange="appState.items['${id}'].syncType = this.value">
                    <option value="post" ${item.syncType === 'post' ? 'selected' : ''}>个人作品</option>
                    <option value="like" ${item.syncType === 'like' ? 'selected' : ''}>公开喜欢</option>
                  </select>
                  <select id="user-sync-count-${id}" class="select-field" style="width:110px; display:inline-block; height:36px; padding:0 8px; border-radius:6px; background:rgba(255,255,255,0.05); color:white; border:1px solid rgba(255,255,255,0.1);" onchange="appState.items['${id}'].syncMaxCount = parseInt(this.value)">
                    <option value="50" ${item.syncMaxCount === 50 ? 'selected' : ''}>最新 50 条</option>
                    <option value="100" ${item.syncMaxCount === 100 ? 'selected' : ''}>最新 100 条</option>
                    <option value="200" ${item.syncMaxCount === 200 ? 'selected' : ''}>最新 200 条</option>
                    <option value="500" ${item.syncMaxCount === 500 ? 'selected' : ''}>最新 500 条</option>
                  </select>
                  <button class="btn btn--sync" style="flex:1; height:36px; border-radius:6px;" onclick="handleUserSync('${escapeHTML(id)}', '${escapeHTML(info.secUid)}')">提取列表</button>
                </div>
              </div>
            `);
            return;
        }

        if (item.syncStatus === 'fetching') {
            setHtmlAndRestoreScroll(el, `
              <div class="video-card user-sync-card" style="flex-direction:column; align-items:stretch;">
                <div class="fav-sync-header" style="margin-bottom:8px">
                  <span class="fav-sync-phase" style="font-size:13px; font-weight:600;">${escapeHTML(item.syncPhase || '正在同步...')}</span>
                  <span class="fav-sync-counter" style="margin-left:8px; font-size:12px; color:var(--c-text-muted);">已发现 ${item.syncCollected || 0} 条</span>
                  <button class="btn btn--stop" style="padding:4px 10px; font-size:11px; border-radius:6px; color:white; border:none; cursor:pointer;" onclick="stopUserSync('${escapeHTML(id)}')">停止打断</button>
                </div>
                <div class="fav-sync-progress" style="height:4px; background:var(--c-border); border-radius:2px; overflow:hidden; margin-top:8px;">
                  <div class="fav-sync-progress-fill indeterminate" style="width:30%"></div>
                </div>
              </div>
            `);
            return;
        }

        if (item.syncStatus === 'error') {
            setHtmlAndRestoreScroll(el, `
              <div class="video-card user-sync-card" style="flex-direction:column; align-items:stretch; border-color: rgba(248, 113, 113, 0.4);">
                <h3 style="font-size:14px; font-weight:600; color:var(--c-error); margin:0 0 8px 0;">获取失败</h3>
                <p style="font-size:12px; color:var(--c-text-muted); margin:0 0 12px 0;">${escapeHTML(item.error || '出错了，请检查本地网络或登录状态')}</p>
                <div style="display:flex; gap:8px;">
                  <button class="btn btn--secondary" style="flex:1; height:32px; border-radius:6px; font-size:12px;" onclick="resetUserSync('${escapeHTML(id)}')">返回重新设置</button>
                  <button class="btn btn--sync" style="flex:1; height:32px; border-radius:6px; font-size:12px;" onclick="handleUserSync('${escapeHTML(id)}', '${escapeHTML(info.secUid)}')">重试同步</button>
                </div>
              </div>
            `);
            return;
        }

        if (item.syncStatus === 'done') {
            const undownloaded = [];
            const downloaded = [];
            const errored = [];

            item.userItems.forEach((uItem, idx) => {
                uItem._idx = idx;
                if (uItem.parseError) {
                    errored.push(uItem);
                } else {
                    const ds = item.userDownloadStates[uItem.awemeId];
                    const isDone = uItem.alreadyDownloaded || (ds && ds.status === 'done');
                    if (isDone) {
                        downloaded.push(uItem);
                    } else {
                        undownloaded.push(uItem);
                    }
                }
            });

            let headerHtml = `
              <div class="video-card user-sync-card" style="flex-direction:column; align-items:stretch; padding:12px 16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:8px;">
                  <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                    <div class="author-avatar" style="width:32px; height:32px; border-radius:50%; background:var(--c-primary); display:flex; align-items:center; justify-content:center; font-weight:bold; color:white; font-size:16px; flex-shrink:0;">👤</div>
                    <div style="min-width:0;">
                      <h3 style="font-size:14px; font-weight:600; color:white; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHTML(item.nickname || info.author?.nickname)}">${escapeHTML(item.nickname || info.author?.nickname || '抖音用户')}</h3>
                      <p style="font-size:11px; color:var(--c-text-muted); margin:0;">主页${item.syncType === 'like' ? '喜欢' : '作品'}同步 (发现 ${item.userItems.length} 条)</p>
                    </div>
                  </div>
                  <button class="btn btn--secondary" style="padding:4px 8px; font-size:11px; border-radius:6px; height:24px; flex-shrink:0;" onclick="resetUserSync('${id}')">重设</button>
                </div>
            `;

            let bodyHtml = '';

            // 多选模式头部
            if (item.isMultiSelectMode) {
                bodyHtml += `
                  <div class="multi-select-bar" style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; background:rgba(124, 58, 237, 0.15); padding:6px 10px; border-radius:6px;">
                    <span style="font-size:12px; font-weight:600; color:var(--c-primary)">已选 ${item.selectedItems.size} 项</span>
                    <div class="multi-select-actions" style="display:flex; gap:6px; align-items:center;">
                      <select class="select-field" style="width:90px; height:22px; padding:0 4px; font-size:11px; border-radius:6px; background:rgba(255,255,255,0.08); color:white; border:1px solid rgba(255,255,255,0.15); cursor:pointer;" onchange="if(this.value) { userSelectRecent('${id}', parseInt(this.value)); this.value=''; }">
                        <option value="" style="background:#1e293b; color:white;">快速勾选...</option>
                        <option value="10" style="background:#1e293b; color:white;">最近 10 条</option>
                        <option value="20" style="background:#1e293b; color:white;">最近 20 条</option>
                        <option value="50" style="background:#1e293b; color:white;">最近 50 条</option>
                        <option value="100" style="background:#1e293b; color:white;">最近 100 条</option>
                      </select>
                      <button class="btn btn--secondary" style="padding:3px 8px; font-size:11px; border-radius:6px; height:22px;" onclick="userSelectAllUndownloaded('${id}')">全选未下载</button>
                      <button class="btn btn--secondary" style="padding:3px 8px; font-size:11px; border-radius:6px; height:22px;" onclick="toggleUserMultiSelectMode('${id}')">取消</button>
                      <button class="btn btn--sync" style="padding:3px 10px; font-size:11px; border-radius:6px; height:22px;" onclick="downloadSelectedUserItems('${id}')" ${item.selectedItems.size === 0 ? 'disabled' : ''}>下载所选</button>
                    </div>
                  </div>
                `;
            }

            // 未下载区域
            bodyHtml += `
              <div class="fav-group" style="${item.isMultiSelectMode ? 'opacity:0.9' : ''}">
                <div class="fav-sync-header" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                  <span class="fav-sync-phase" style="font-size:12px; font-weight:600; color:var(--c-text)">📥 未下载 (${undownloaded.length})</span>
                  ${(!item.isMultiSelectMode && item.userItems.length > 0) ? `
                  <div style="display:flex; gap:6px; align-items:center;">
                    <select class="select-field" style="width:90px; height:22px; padding:0 4px; font-size:11px; border-radius:6px; background:rgba(255,255,255,0.08); color:white; border:1px solid rgba(255,255,255,0.15); cursor:pointer;" onchange="if(this.value) { userSelectRecent('${id}', parseInt(this.value)); this.value=''; }">
                      <option value="" style="background:#1e293b; color:white;">快速勾选...</option>
                      <option value="10" style="background:#1e293b; color:white;">最近 10 条</option>
                      <option value="20" style="background:#1e293b; color:white;">最近 20 条</option>
                      <option value="50" style="background:#1e293b; color:white;">最近 50 条</option>
                      <option value="100" style="background:#1e293b; color:white;">最近 100 条</option>
                    </select>
                    <button class="btn btn--secondary" onclick="toggleUserMultiSelectMode('${id}')" style="padding:3px 8px; font-size:11px; border-radius:6px; height:22px;">多选</button>
                    ${undownloaded.length > 0 ? `<button class="btn btn--sync" onclick="downloadAllUserItems('${id}')" style="padding:3px 8px; font-size:11px; border-radius:6px; height:22px; display:inline-flex; align-items:center; gap:3px;">
                       <span>全部下载</span>
                    </button>` : ''}
                  </div>` : ''}
                </div>`;

            if (undownloaded.length === 0) {
                bodyHtml += '<div style="padding:10px 0; text-align:center; color:var(--c-text-muted); font-size:11px">🎉 全部已下载</div>';
            } else {
                bodyHtml += '<div class="fav-sync-items" style="max-height:220px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; border:1px solid rgba(255,255,255,0.05); padding:4px; border-radius:6px; background:rgba(0,0,0,0.1);">';
                bodyHtml += undownloaded.map(uItem => renderUserItemCardHTML(id, uItem, false)).join('');
                bodyHtml += '</div>';
            }
            bodyHtml += '</div>';

            // 已下载区域（可折叠）
            if (downloaded.length > 0) {
                bodyHtml += `
                  <div class="fav-group" style="margin-top:10px">
                    <div class="fav-sync-header fav-downloaded-toggle" onclick="toggleUserDownloadedList('${id}')" style="cursor:pointer; margin-bottom:${item.downloadedExpanded ? '8' : '0'}px; display:flex; justify-content:space-between; align-items:center; padding:4px 0;">
                      <span class="fav-sync-phase" style="display:flex; align-items:center; gap:4px; font-size:12px; font-weight:600; color:var(--c-text);">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"
                             style="transition:transform 0.2s; transform:rotate(${item.downloadedExpanded ? '90' : '0'}deg)">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                        ✅ 已下载 (${downloaded.length})
                      </span>
                      <span class="fav-sync-counter" style="font-size:10px; color:var(--c-text-muted)">点击${item.downloadedExpanded ? '收起' : '展开'}</span>
                    </div>`;

                if (item.downloadedExpanded) {
                    bodyHtml += '<div class="fav-sync-items" style="max-height:160px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; border:1px solid rgba(255,255,255,0.05); padding:4px; border-radius:6px; background:rgba(0,0,0,0.1);">';
                    bodyHtml += downloaded.map(uItem => renderUserItemCardHTML(id, uItem, true)).join('');
                    bodyHtml += '</div>';
                }
                bodyHtml += '</div>';
            }

            if (errored.length > 0) {
                bodyHtml += '<div style="margin-top:8px; display:flex; flex-direction:column; gap:4px;">';
                bodyHtml += errored.map(uItem => `<div class="fav-sync-item" style="opacity:0.5; padding:4px 8px; font-size:11px; color:var(--c-error)">
                    <span class="fav-sync-item-title">${uItem.title} (解析失败: ${uItem.parseError})</span>
                </div>`).join('');
                bodyHtml += '</div>';
            }

            setHtmlAndRestoreScroll(el, headerHtml + bodyHtml + '</div>');
            return;
        }
    }

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

    setHtmlAndRestoreScroll(el, `
      <div class="video-card">
        <div class="video-cover-wrap">
          <img class="video-cover" src="${escapeHTML(info.cover || '')}" alt="封面">
          ${durationHtml}
        </div>
        <div class="video-meta">
          <h2 class="video-title" title="${escapeHTML(info.title)}">${escapeHTML(info.title)}</h2>
          <div class="video-author">
            <span class="author-label">作者</span>
            <span>${escapeHTML(info.author)}</span>
          </div>
          <div class="video-specs">
            ${resHtml}
          </div>
          <button class="btn btn--download" onclick="handleDownload('${escapeHTML(id)}')" ${btnDisabled ? 'disabled' : ''}>
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
    `);
}

// ── 渲染收藏列表（分两组：未下载 + 已下载折叠） ──
function renderFavList() {
    const panel = document.getElementById('favSyncPanel');
    if (!favSyncedItems || favSyncedItems.length === 0) {
        setHtmlAndRestoreScroll(panel, '<div class="fav-login-hint">收藏列表为空</div>');
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
            <span class="fav-sync-item-title">${escapeHTML(item.title)} (解析失败)</span>
        </div>`).join('');
        html += '</div>';
    }

    setHtmlAndRestoreScroll(panel, html);
}

function renderFavItemCard(item, isDownloadedSection) {
    const idx = item._idx;
    const coverHtml = item.cover
        ? `<img src="${escapeHTML(item.cover)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
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

    const authorHtml = item.author ? `<span style="font-size:11px;color:var(--c-text-muted)">@${escapeHTML(item.author)}</span>` : '';

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
            <span class="fav-sync-item-title" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</span>
            ${authorHtml}
        </div>
        ${actionHtml}
    </div>`;
}

// ── 渲染喜欢列表 ──
function renderLikedList() {
    const panel = document.getElementById('likedSyncPanel');
    if (!likedSyncedItems || likedSyncedItems.length === 0) {
        setHtmlAndRestoreScroll(panel, '<div class="fav-login-hint">喜欢列表为空</div>');
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
            <span class="fav-sync-item-title">${escapeHTML(item.title)} (解析失败)</span>
        </div>`).join('');
        html += '</div>';
    }

    setHtmlAndRestoreScroll(panel, html);
}

function renderLikedItemCard(item, isDownloadedSection) {
    const idx = item._idx;
    const coverHtml = item.cover
        ? `<img src="${escapeHTML(item.cover)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
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

    const authorHtml = item.author ? `<span style="font-size:11px;color:var(--c-text-muted)">@${escapeHTML(item.author)}</span>` : '';

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
            <span class="fav-sync-item-title" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</span>
            ${authorHtml}
        </div>
        ${actionHtml}
    </div>`;
}

// ── 渲染私信列表 ──
function renderMsgList() {
    const panel = document.getElementById('msgSyncPanel');
    if (!msgSyncedItems || msgSyncedItems.length === 0) {
        setHtmlAndRestoreScroll(panel, '<div class="fav-login-hint">未在私信中发现视频链接</div>');
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

    setHtmlAndRestoreScroll(panel, html);
}

function renderMsgItemCard(item, isDownloadedSection) {
    const idx = item._idx;
    const coverHtml = item.cover
        ? `<img src="${escapeHTML(item.cover)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
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

    const authorHtml = item.author ? `<span style="font-size:11px;color:var(--c-text-muted)">@${escapeHTML(item.author)}</span>` : '';

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
            <span class="fav-sync-item-title" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</span>
            ${authorHtml}
        </div>
        ${actionHtml}
    </div>`;
}

// ── 渲染用户主页作品卡片 ──
function renderUserItemCardHTML(cardId, uItem, isDownloadedSection) {
    const item = appState.items[cardId];
    const idx = uItem._idx;
    const coverHtml = uItem.cover
        ? `<img src="${escapeHTML(uItem.cover)}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
        : '';

    const dState = item.userDownloadStates[uItem.awemeId];
    const isDownloading = dState && dState.status === 'downloading';
    const isDownloaded = uItem.alreadyDownloaded || (dState && dState.status === 'done');
    const isError = dState && dState.status === 'error';

    let actionHtml = '';

    if (isDownloading) {
        const progress = dState.progress || 0;
        actionHtml = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <div style="width:50px;height:4px;background:var(--c-border);border-radius:2px;overflow:hidden">
                <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,var(--c-primary),var(--c-accent));border-radius:2px;transition:width 0.3s"></div>
            </div>
            <span style="font-size:10px;color:var(--c-primary);font-family:var(--font-mono);white-space:nowrap">${progress}%</span>
        </div>`;
    } else if (isDownloadedSection && isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <button class="btn btn--primary" style="padding:4px 8px;font-size:10px;border-radius:6px;opacity:0.7;height:24px;" onclick="redownloadUserItem('${cardId}', ${idx})" title="重新下载">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
            </button>
            <button class="action-btn action-btn--open" style="opacity:1;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;" onclick="openUserFile('${cardId}', ${idx})" title="打开文件夹">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
            </button>
            <button class="action-btn action-btn--delete" style="opacity:1;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;" onclick="deleteUserFile('${cardId}', ${idx})" title="删除文件">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>`;
    } else if (!isDownloaded) {
        actionHtml = `<button class="btn btn--primary" style="padding:4px 10px;font-size:11px;border-radius:6px;white-space:nowrap;flex-shrink:0;height:24px;" onclick="downloadUserItem('${cardId}', ${idx})">
            <span>下载</span>
        </button>`;
    }

    if (isError && !isDownloaded) {
        actionHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <span style="font-size:10px;color:var(--c-error)">失败</span>
            <button class="btn btn--primary" style="padding:3px 8px;font-size:10px;border-radius:6px;height:22px;" onclick="downloadUserItem('${cardId}', ${idx})">重试</button>
        </div>`;
    }

    const isSelected = item.selectedItems.has(idx);
    const checkboxHtml = item.isMultiSelectMode ? `
        <div class="fav-checkbox-wrap" style="margin-right:6px;">
            <input type="checkbox" class="fav-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleUserItemSelection('${cardId}', ${idx})" />
        </div>
    ` : '';

    if (item.isMultiSelectMode) {
        actionHtml = '';
    }

    return `<div class="fav-sync-item ${isSelected ? 'selected' : ''}" style="padding:6px 8px;gap:8px;align-items:center;${item.isMultiSelectMode ? 'cursor:pointer;' : ''}" ${item.isMultiSelectMode ? `onclick="toggleUserItemSelection('${cardId}', ${idx})"` : ''}>
        ${checkboxHtml}
        ${coverHtml}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
            <span class="fav-sync-item-title" style="font-size:12px;line-height:1.3;" title="${escapeHTML(uItem.title)}">${escapeHTML(uItem.title)}</span>
            <span style="font-size:10px;color:var(--c-text-muted)">@${escapeHTML(uItem.author || item.nickname || '作者')}</span>
        </div>
        ${actionHtml}
    </div>`;
}

// ── 切换下载列表折叠 ──
function toggleDownloadedList() {
    favDownloadedExpanded = !favDownloadedExpanded;
    renderFavList();
}

function toggleLikedDownloadedList() {
    likedDownloadedExpanded = !likedDownloadedExpanded;
    renderLikedList();
}

function toggleMsgDownloadedList() {
    msgDownloadedExpanded = !msgDownloadedExpanded;
    renderMsgList();
}
