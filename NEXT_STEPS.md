# 下一步计划 (Next Steps)

按照优先级排序：

## 1. Docker 化部署适配 (高优先级)
- 编写 `Dockerfile`，配置轻量级 Node.js 基础镜像（如 `node:18-alpine`）。
- 为了支持 Linux 容器环境内的外置下载路径，新增对环境变量（如 `DOWNLOAD_DIR`）的读取支持。
- 编写 `docker-compose.yml` 方便在飞牛 OS 等 NAS 系统上一键部署，并配置 Volumes 映射宿主机硬盘。

## 2. 网页 UI 移动端深度优化 (中优先级)
- 优化 PWA (Progressive Web App) 支持，添加 `manifest.json` 与 `Service Worker`，让手机访问时能完美生成桌面图标，隐藏浏览器地址栏，呈现原生级全屏体验。
- 梳理手机端的输入栏与按钮交互，防止虚拟键盘遮挡。

## 3. 功能演进 (低优先级)
- **多任务并发队列表现优化**：目前直接发出请求，若未来需要排队下载几百个视频，应当在后端引入类似 `Bull` 或单纯的 Promise 队列控制并发量。
- **自定义 Cookie 注入**：为应对未来可能的平台封号或限制，可以在设置面板新增填入个人 Cookie 的入口。
