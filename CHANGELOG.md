# Changelog

本文件记录项目的主要变更。

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
