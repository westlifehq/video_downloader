## [v8.3.2] - 2026-08-07

### Fixed
- **小红书新短链域名 `xhslink.cn` 支持**：小红书分享短链新增 `.cn` 域名，`routes/parse.js` 域名白名单与平台识别同步放行，修复新链接报「仅支持解析抖音 / 小红书链接」或被误判为抖音导致解析失败。
- **小红书封面防盗链**：小红书 CDN（`sns-webpic*.xhscdn.com`）对非小红书 Referer 返回 403，导致封面在页面中显示为撕裂/破损图；所有外域封面 `<img>`（解析卡片、收藏/喜欢/私信/用户列表、下载历史）增加 `referrerpolicy="no-referrer"`，加载封面时不发送 Referer。
- **分享文本尾部标点剥离**：`lib/douyin.js` `extractUrl()` 匹配时排除中文标点并剥离英文闭合标点，修复分享文案紧跟标点时 URL 混入导致请求失败。
- **退出登录浏览器清理**：`lib/douyin-favorites.js` `logout()` 不再调用 BrowserContext 不存在的 `.contexts()` 方法，改为直接 `clearCookies()` + `close()`，修复浏览器进程泄漏与登录态无法彻底清理。
- **服务稳定性**：`server.js` `unhandledRejection` 仅记录错误日志不再退出进程，单个异步错误（如一次网络请求失败）不再拖垮整个服务。
- **按钮图标尺寸兜底**：修复下载按钮等未设 `width/height` 的 SVG 按默认 300px 渲染、撑爆卡片的问题；`public/style.css` 新增 `.btn svg` / `.action-btn svg` / `.fav-sync-item-status` 16px 尺寸兜底，`render.js` 下载按钮 SVG 补内联尺寸。
- **本地化字体**：`public/index.html` 由 Google Fonts 外链改为本地 `public/fonts/`（含 `material-symbols-outlined.woff2`），国内访问不再依赖外网 CDN。

### Security
- **下载目录敏感路径前缀匹配**：`routes/config.js` 危险目录黑名单由精确匹配改为前缀匹配，禁止将 `/usr/local`、`/etc/nginx` 等敏感目录的子路径设为下载目录。
- **SSRF 纵深防御**：`routes/parse.js` 短链重定向后的真实链接再次校验域名白名单，防止被重定向到任意内网/外部地址。
- **同步条数上限**：`routes/sync.js` 收藏 / 喜欢 / 私信 / 用户主页同步 `maxCount` 统一规范化限制为 1~500，防止超大值导致 Playwright 长时间抓取。
- **诊断截图不外泄**：`lib/douyin-favorites.js` 同步调试截图由 `public/` 移至 `user_data/debug/`，避免被静态服务对外暴露。
- **测试用例健壮性**：`tests/security.test.js` mock 恢复包裹 `try/finally`，断言失败不再污染后续用例。

### Changed
- `package.json` 版本 `8.3.1` → `8.3.2`；axios 升级至 `^1.7.0`，uuid 升级至 `^11.1.1`（本地与 Docker 部署已验证）。
- `nas-deployment/Dockerfile` 增加 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` / `PLAYWRIGHT_BROWSERS_PATH`（跳过浏览器重复下载）与 `HEALTHCHECK`。
- `public/` 移除历史遗留的诊断截图 `fav_debug.png`。

### Verified
- `node --test tests/security.test.js` — 11/11 通过
- 本地与 N100 Docker 部署实测：`xhslink.cn` 新短链解析、小红书封面渲染（1080×1441 完整加载）、下载功能均正常

---

# Changelog

本文件记录项目的主要变更。

## [v8.3.0] - 2026-05-27 19:30 +08:00

### Security
- **API Token 鉴权**：新增 `API_TOKEN` 环境变量，启用后所有 `/api/*` 请求须携带 `Authorization: Bearer <token>`，解决 NAS/Docker 部署匿名可访问的问题。
- **下载 URL 白名单**：`lib/douyin.js` 新增 `TRUSTED_DOWNLOAD_HOSTS` + `getSafeDownloadUrl()`，限制下载协议仅 `http/https`、主机仅信任平台域名，防止后端变成任意 URL 下载代理（SSRF）。
- **远程文件管理禁用**：新增 `DISABLE_REMOTE_FILE_ACTIONS` 环境变量，启用后 `/api/history/open` 和 `/api/history/delete` 返回 `403`，缩小 NAS 远程攻击面。
- **Docker 容器硬化**：Dockerfile 改为 `USER pwuser` 非 root 运行；docker-compose 新增 `cap_drop: ALL`、`no-new-privileges:true`、`tmpfs /tmp`。

### Fixed
- **定时同步防重入**：`lib/scheduler-service.js` 新增全局互斥锁，阻止 cron 触发与手动执行并发重叠导致的重复浏览器启动。
- **task-manager 写盘合并**：`lib/task-manager.js` 新增 `queueSave()` 合并并发写盘请求 + `saveRequestedDuringFlush` 脏标记二次落盘，减少高频状态更新时的重复 IO。
- **历史数据源收敛**：前端历史记录从 `localStorage('dy_history')` 收敛为后端 `/api/history` 唯一权威源，消除双源数据漂移。删除 4 处冗余 `addToHistory()` 和 4 处冗余 `localStorage.filter` 逻辑。
- **下载轮询超时保护**：主解析下载轮询增加连续失败 60 次上限（30 秒），超时后终止并提示用户。
- **轮询 Timer 清理**：新增 `clearPollTimer()` 统一清理，避免 interval 被 `clearInterval()` 后仍残留在状态对象。
- **前端非 JSON 错误容错**：`public/js/api.js` 检测 `Content-Type` 后再决定解析方式，后端返回纯文本错误时不再因 `.json()` 解析失败报错。

### Added
- **前端 Token 设置入口**：设置面板新增 API Token 输入框 + 保存/清除按钮，前端请求自动附带 `Authorization` header。
- **安全测试套件**：新增 `tests/security.test.js`，11 个测试覆盖路径安全、URL 白名单、并发互斥、写盘合并、路由级校验。
- `package.json` 新增 `npm test` 脚本。

### Changed
- `package.json` 包名从 `douyin-downloader` 改为 `video-downloader`，版本对齐 `8.3.0`。
- `README.md` NAS 部署章节补充安全建议（修改 Token、不裸露公网）。
- `README.md` axios 兼容性说明改为更中性的表述。

### Metadata
- Branch: `main`
- Scope: `server.js`, `lib/douyin.js`, `lib/scheduler-service.js`, `lib/task-manager.js`, `routes/history.js`, `public/js/api.js`, `public/js/app.js`, `public/index.html`, `nas-deployment/*`, `package.json`, `README.md`, `tests/security.test.js`

### Verified
- `node --test tests/security.test.js` — 11/11 通过

---

## [v8.2.1] - 2026-05-25 23:25 +08:00

### Fixed
- **修复 Docker 定时同步被浏览器锁误拦截**：`lib/douyin-favorites.js` 中 `fetchMessageVideos()` 的 `finally` 现在会显式执行 `activeBrowser = null`，避免上一轮私信同步结束后未释放全局浏览器锁，导致下一轮随机定时任务直接报“已有一个浏览器窗口在运行，请先完成当前操作”。

### Metadata
- Branch: `main`
- Commit base: `e0719e3`
- Scope: `lib/douyin-favorites.js`

### Verified
- 通过容器日志与 `schedule_log.json` 定位到 2026-05-24 04:45 的失败原因为浏览器锁未释放。
- Docker 已按增量覆盖方式更新，容器内 `/app/lib/douyin-favorites.js` 已确认包含新增的 `activeBrowser = null;`。
- Docker 服务 `http://127.0.0.1:3000` 返回 `200`。


## [v8.2.0] - 2026-05-22 11:20 +08:00

### Fixed
- **主页同步昵称串号**：优先拦截 `/web/user/profile/other/` 资料接口读取目标用户昵称，不再依赖网页标题，修复昵称随机串成其他作者的问题。
- **跨用户缓存污染**：主页同步前新增浏览器缓存与 ServiceWorker 清理，避免不同名片链接返回同一批结果。
- **已下载误判**：`routes/sync.js` 的已下载判定改为仅检查当前用户历史批量下载目录，不再把根目录零散文件误判为当前用户已下载。
- **Safari/前端缓存残留旧菜单**：`server.js` 添加 `no-cache` 响应头，`public/index.html` 更新资源版本号，确保旧菜单不再显示。

### Changed
- **移除主页同步"公开收藏"入口**：`render.js`/`app.js`/`routes/sync.js` 统一删除"公开收藏"选项，当前仅保留"个人作品"和"公开喜欢"，因抖音 Web 端无法稳定查看他人收藏。

### Verified
- 本地实测名片 `https://v.douyin.com/EBJBywZLSUk/`：50 条喜欢，昵称 `不歪大叔Koi💦`，已下载 0，可下载 50。


## [v8.1.0] - 2026-05-22

### Security (P0 — 严重安全修复)
- **阻断任意文件删除攻击链**：`routes/config.js` 对 `downloadDir` 新增危险路径黑名单（系统根目录、`/etc`、`C:\Windows` 等）与绝对路径强制校验，彻底阻止通过篡改下载目录配合 `isPathSafe` 绕过的文件删除链。
- **本地模式绑定 127.0.0.1**：`server.js` 默认绑定 `127.0.0.1`，同网段设备不再可直接访问所有 API。Docker/NAS 环境通过 `IS_DOCKER` 环境变量或 `/.dockerenv` 检测自动保持 `0.0.0.0`。
- **全面修复前端 XSS 漏洞**：
  - `render.js` 的 `updateCard()` 中 `info.title`/`info.author`/`info.cover`/`item.error`/`item.url`/`item.nickname` 全部使用 `escapeHTML()` 转义。
  - `render.js` 中 `secUid` 不再裸拼入 `onclick` 属性，改为 `escapeHTML()` 防御注入。
  - `app.js` 三个同步模块（收藏/喜欢/私信）的轮询面板 `task.phase`/`task.error` 全部用 `escapeHTML()` 处理。
  - 历史记录作者下拉菜单、定时同步日志渲染均补充 `escapeHTML()`。

### Fixed (P1 — 中等问题修复)
- **移除 exec 命令注入风险**：`lib/douyin-favorites.js` 的 `logout()` 移除 `exec('rm -rf')` fallback，仅保留安全的 `fs.rm()`。
- **诊断截图不再写入 public/**：`login_debug.png` 保存路径从 `public/` 移至项目根目录，避免通过静态文件服务直接访问泄露二维码。
- **修复竞态条件**：`saveSyncedIds()`/`saveLikedIds()`/`appendScheduleLog()` 引入文件锁机制，防止并发 read-modify-write 导致数据丢失。
- **修复浏览器实例泄漏**：`fetchMessageVideos()` 启动浏览器后正确注册 `activeBrowser = context`。
- **修复 checkLoginStatus 缺失 await**：登录检测分支补齐 `await`，避免 Promise 对象被当作 truthy 导致条件永真。
- **下载失败清理不完整文件**：`lib/douyin.js` stream error 时自动 close writer 并 unlink 残留文件。
- **错误响应不再泄露内部路径**：`routes/parse.js`、`routes/history.js`、`routes/config.js` 错误返回改为通用提示。
- **轮询增加最大重试限制**：所有前端下载轮询 `setInterval` 增加 60 次连续失败上限（30秒），超时后自动停止并提示用户。
- **rangeStart/rangeEnd 格式校验**：`routes/config.js` 新增 `HH:MM` 正则验证。
- **secUid 格式校验**：`routes/sync.js` 新增正则校验，拒绝非法格式的 secUid。

### Changed
- README.md 新增安全性说明章节。

---

## [v8.0.0] - 2026-05-21

### Added
- **代码安全性与系统稳定性升级**：
  - 路径越界校验：引入 `isPathSafe`，拦截历史记录打开和删除的越界行为。
  - 无 Shell 命令调用：打开文件用 `spawn` 代替 `exec`，避免文件名或物理路径导致的命令注入风险。
  - 小红书解析器非阻塞化：重构为 Promise + `spawn` 调起 `curl`。
  - 登录态自动同步持久化：扫码登录成功后自动回写 `sessionid` Cookie 避免不一致。
  - 全站防 XSS 攻击：前端对所有 `innerHTML` 中含有用户输入的字段（作者、标题等）应用 `escapeHTML`。
  - 绝对路径混淆映射：引入随机混淆 ID Map (`pathIdMap`) 替换前端 DOM 中的绝对路径传递，杜绝单双引号和特殊符号在 `onclick` 中转义逃逸带来的 JS 执行崩溃与注入风险。
  - 智能等待轮询：重构 `lib/douyin-favorites.js` 中 11 处固定 `waitForTimeout` 延时，改为响应式智能轮询等待，同步整体耗时显著缩短 80% 以上。
  - 异步逻辑加固：在 `routes/sync.js` 和 `lib/scheduler-service.js` 中补齐了缺失的异步 `await` 关键字，防范并发调用问题。
  - 彻底删除被完全重构替代的旧前端脚本 `public/app.js`，避免代码冲突与冗余。

## [Unreleased] - 2026-05-01

### Fixed
- **私信视频解析**：修复容器环境下私信同步 0 解析的问题。容器公网 IP 触发抖音风控，未登录的 axios 请求只能拿到验证页 HTML。改为复用已登录的 Playwright context 在新页面内拉取分享页（cookie / 浏览器指纹与收藏/喜欢同步保持一致）。
  - `fetchMessageVideos` 中视频解析循环移入 `try/finally` 内，保持 context 存活
  - 新增 `fetchVideoInfoViaContext`：在已登录 context 内 new page 拉取 `https://www.iesdouyin.com/share/video/{id}/`
  - 新增 `extractItemFromHtml`：解析 `_ROUTER_DATA` / `_SSR_DATA` 中的 `item_list`
  - 解析失败时回退到 `page.evaluate` fetch `/aweme/v1/web/aweme/detail`（携带 cookie）
  - 视频间延迟 `500ms` → `800ms`，降低触发频率
  - 验证：NAS 容器内 5 条私信视频成功解析 4 条，含真实 `videoUrl`

### Changed
- **消除 `nas-deployment/` 目录的重复代码**：原本 `nas-deployment/` 内维护了一份 `server.js / lib / public / package*.json`，每次修改都需手动同步两份，已经导致过线上回归。
  - `nas-deployment/docker-compose.yml`：build context 改为 `..`（项目根），`dockerfile: nas-deployment/Dockerfile`
  - `nas-deployment/Dockerfile`：从根目录 `COPY` 源码
  - 删除 `nas-deployment/` 内的 `server.js / lib/ / public/ / package*.json / .dockerignore`（统一以根目录为单一来源）
  - 根目录新增 `.dockerignore`

### Removed
- 未使用依赖 `@larksuite/cli`
- 测试脚本 `test-chat.js`、`test-messages*.js`（共 8 个）
- 调试截图 `fav_debug.png`
- 不应入库的笔记类文件 `CURRENT_STATUS.md` / `DECISIONS.md` / `NEXT_STEPS.md` / `PROJECT_CONTEXT.md` / `WORKSPACE_RULES.md`（已加入 `.gitignore`）

### Ops
- 清理 NAS 上 10 个悬空 `nas-deployment-downloader` Docker 镜像
- 删除 NAS 上旧部署目录 `/tmp/nas-deployment` 与 `/tmp/nas-upload`，统一使用 `/tmp/dy-new`

---

## [2026-04-30] 7f9b4dc

### Fixed
- 完整同步 NAS 部署版（私信同步、标题、`app.js`、`douyin-favorites.js`）

## [2026-04-30] ce77be1

### Fixed
- 同步 NAS 部署版定时私信选项

## [2026-04-30] b650596

### Added / Fixed
- 定时同步支持私信
- 修复时区导致随机任务不触发

## [2026-04-30] 7d48674

### Added
- 私信视频同步
- 定时保存按钮
- 若干 bug 修复
