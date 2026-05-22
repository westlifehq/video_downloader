# Changelog

本文件记录项目的主要变更。

## [v8.3.0] - 2025-07-18

### Removed (移除不可用功能)
- **移除"收藏"和"收藏夹"同步功能**：经验证，抖音网页版不支持查看他人的收藏/收藏夹（仅 APP 端可见）。网页端导航到收藏 URL 会跳转到登录用户自己的收藏页面，导致返回错误数据。现在前端仅保留"个人作品"和"公开喜欢"两个选项，后端对 `favorite`/`collection` 类型请求返回明确错误。
- 删除 `fetchUserCollections()` 函数（约 430 行死代码）。

### Fixed (用户同步核心修复)
- **修复不同用户链接返回相同结果**：通过 CDP 协议（`Network.clearBrowserCache` + `Network.setCacheDisabled`）在每次同步启动时彻底清除浏览器 HTTP 缓存，解决持久化浏览器上下文在不同用户同步间泄露缓存 API 响应的问题。
- **修复"已下载"误判**：用户主页同步不再依赖全局 `synced_ids.json`/`liked_ids.json` ID 池判断是否已下载，仅以实际文件存在为准。
- **精简 API 拦截规则**：仅匹配 `post`（作品）和 `like`（喜欢）两种 API，消除误匹配导致的数据污染。

## [v8.2.0] - 2025-07-17

### Added (收藏夹同步新功能)
- **收藏夹（文件夹模式）同步**：新增 `tabType = 'collection'` 选项，支持检测用户收藏 tab 下的命名收藏夹，逐个进入采集视频内容。如未检测到收藏夹结构，自动回退为普通收藏列表模式。
- 前端用户同步卡片新增"收藏夹"下拉选项。

### Fixed (用户同步功能 Bug 修复)
- **修复收藏列表始终返回同一用户数据**：`fetchUserPosts` 新增浏览器缓存禁用（`--disk-cache-size=0`）、启动时关闭残留页面、导航前不采集 API 响应（`pageNavigated` 标志位），以及 sec_uid 校验机制，防止拦截到前一次同步的缓存数据。
- **修复昵称始终显示错误**：不再从视频的 `author.nickname` 覆盖用户昵称，改为仅从页面标题和 DOM 元素提取**资料页主人**的昵称。
- **修复喜欢列表"已下载"误判**：`routes/sync.js` 用户同步的 `alreadyDownloaded` 判断现在根据 `tabType` 匹配对应的 ID 池（喜欢→`liked_ids.json`，收藏→`synced_ids.json`），不再跨池误标。
- **修复喜欢列表同步不完整**：增大滚动次数上限（40→60）、stale 阈值（6→10）、等待超时（2-3.5s→2.5-4.5s）和 tab 切换等待时间（4s→6s），减少因加载慢导致的提前终止。
- **API 响应拦截精准化**：对 `like` 和 `favorite` 使用更精确的 URL 匹配规则，减少误拦截无关 API 导致 `has_more=false` 提前终止。

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
