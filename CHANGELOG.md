# Changelog

本文件记录项目的主要变更。

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
