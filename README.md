# Video Downloader (全平台视频无水印下载器)

> 🚀 一个基于 Node.js 构建的现代化、极简、高颜值的全平台视频内容解析及下载工具。

![UI Preview](https://img.shields.io/badge/Status-Active-success)
![Version](https://img.shields.io/badge/Version-2.3.0-blue)
![Nodejs](https://img.shields.io/badge/Node.js-18.x-blue)
![License](https://img.shields.io/badge/License-MIT-blue)

## 🌟 核心特性

- **高级收藏夹同步 (v2.1)**：支持扫码登录后自动同步收藏视频。新增 **「同步打断」** 机制（加载过慢时可随时结算并停止滚动）以及 **「多选批量下载」** 模式（支持一键勾选未下载视频进行并发下载）。
- **新增喜欢视频同步**：在现有收藏同步之外，新增 **「同步喜欢」** 入口，支持抓取抖音账号喜欢的视频列表，并提供单条下载、批量下载、多选下载、已下载折叠查看等能力。
- **私信视频同步 (v2.3)**：新增 **「私信同步」** 功能，自动扫描抖音私信会话中分享的视频链接并批量提取下载。通过 API 拦截精准获取视频 ID，支持虚拟滚动列表的可见性检测，避免误点不可见元素。
- **Cookie 直登优化**：前端手动注入 `sessionid` 时不再依赖 Playwright 浏览器启动，网页内即可直接完成凭证绑定，避免因浏览器内核未安装导致登录失败。
- **Windows 一键启动修复**：`run.cmd` 与 `run-downloader.cmd` 现已支持自动回退到 Node.js 模式，并在首次运行时自动安装 npm 依赖与 Playwright Chromium。
- **物理文件双向同步**：支持在下载历史和收藏面板直接「打开文件位置」或「从磁盘物理删除」，实现下载状态与本地文件的实时对齐。
- **跨平台解析**：支持 **抖音 (Douyin)** 和 **小红书 (Xiaohongshu)** 视频内容解析，自动识别平台并切换引擎。
- **无水印原画质**：直取底层接口，下载官方无压缩、无水印的 1080P/720P 原视频。
- **自动短链追踪**：支持分享短链接，自动识别并跟随 302 重定向。
- **极速批量处理**：支持在输入框同时粘贴多条链接，自动剥离文字，多线程并行解析与下载。
- **高级定制 UI v3**：采用全新的 **Glassmorphism 浅色渐变** 设计语言，支持桌面顶部导航、移动端底部导航、图标化品牌头部以及更清晰的同步 / 历史 / 设置信息层级。
- **跨平台一键部署**：无论是 Mac、Windows 还是 Linux，仅需 Node 环境即可轻松跑满带宽。

---

## 🆕 相比「新增喜欢功能」之后的详细更新

以下内容为基于 `feat: add douyin liked sync support` 之后的持续迭代，方便老用户快速了解最近新增了什么：

### 1. 定时同步能力补齐

- 新增 **定时同步** 面板，可直接在网页端开启 / 关闭自动任务。
- 支持按 **固定时间** 每日执行同步。
- 支持按 **随机时间段** 执行，例如每天 `00:00 - 06:00` 之间随机触发一次，用于降低固定时刻请求带来的风控特征。
- 支持设置 **同步范围**：仅收藏、仅喜欢、收藏+喜欢（去重）。
- 支持设置 **最大同步条数**，避免单次拉取或下载过多内容。
- 新增 **立即执行** 与 **执行日志**，可以随时手动触发并查看结果。

### 2. 下载历史增强

- 下载历史新增 **筛选能力**：支持关键词筛选、作者筛选、时间范围筛选。
- 历史面板与本地文件状态进一步打通，便于快速清理和定位文件。

### 3. 同步面板重构

- 原来分散的收藏同步、喜欢同步、定时同步、凭证绑定，现已整合为统一的 **抖音同步卡片**。
- 新 UI 改为 **Tab 结构**：`收藏 / 喜欢 / 定时 / 凭证`，减少页面割裂感。
- 收藏和喜欢同步按钮、同步列表、下载状态展示统一了交互和样式。
- “设置”入口现已支持 **自动展开并滚动到设置区域**，移动端与桌面端行为一致。

### 4. 前端视觉重设计

- 页面整体从上一版极简卡片风格升级为 **浅色玻璃拟态 + 蓝紫 Mesh 渐变背景**。
- 新增 **桌面端顶部导航** 与 **移动端底部导航**，浏览路径更清楚。
- 品牌头部升级为 **下载文件夹图标化标识**，不再只是纯文本标题。
- 按钮、进度条、标签、毛玻璃容器、图标系统已统一，视觉一致性更高。
- 修复了同步中按钮文字字号异常、设置按钮不滚动等细节问题。

### 5. 部署副本同步更新

- `nas-deployment/` 中的前端与后端逻辑已同步支持上述同步面板与定时能力。
- 本地版与 NAS 部署版的交互行为保持一致，降低双环境维护成本。

### 6. 私信视频同步 (v2.3)

- 新增 **「私信同步」** 功能入口，自动遍历抖音私信会话列表，提取会话中分享的视频链接并批量下载。
- 使用 `/chat?isPopup=1` 页面 + API 响应拦截精准获取 `aweme_id`，无需手动复制链接。
- 支持虚拟滚动列表的 **可见性检测**，仅点击可见的会话项，避免超时错误。
- 修复 `normalizeVideoData` 被重复调用导致 "未找到视频或图文数据" 的 bug。
- 定时任务面板新增 **「保存」按钮**，避免修改设置后未触发 `onchange` 就刷新导致配置丢失。

---

## 📸 功能演示

<img width="715" height="267" alt="image" src="https://github.com/user-attachments/assets/d88a4760-5625-45e0-aad0-2799da7286db" />


---

## 🛠 快速开始 / Quick Start

### 环境依赖
确保你已经安装了 [Node.js](https://nodejs.org/) (推荐 v16 以上版本)。

### 安装步骤

1. 克隆本项目到本地
```bash
git clone https://github.com/westlifehq/video_downloader.git
cd video_downloader
```

2. 安装依赖模块
```bash
npm install
```

3. 本地启动服务（Windows 可直接双击 `run-downloader.cmd`，Mac 用户可直接双击项目中的 `启动抖音下载器.command`）
```bash
npm run dev
# 或直接执行 node server.js
```

Windows 启动脚本会自动处理以下事项：
- 检测 Node.js 是否存在
- 首次运行时自动执行 `npm install`
- 首次运行时自动执行 `npx playwright install chromium`

4. 自动打开浏览器体验
服务启动后，浏览器会自动运行或手动访问 [http://localhost:3000](http://localhost:3000) 。

5. **抖音收藏 / 喜欢同步使用说明**：
   - 收藏同步与喜欢同步共用同一套抖音登录态。
   - 前端支持直接粘贴 `sessionid` 完成 Cookie 绑定，无需先启动浏览器。
   - 首次进行「同步收藏」或「同步喜欢」时，程序会自动调用 Playwright Chromium 抓取网页版列表。
   - 登录信息保存在本地 `douyin_session.json` 与 `user_data/` 目录，不会上传服务器。
   - 已下载状态会分别持久化到 `synced_ids.json` 与 `liked_ids.json`。

---

## 📦 如何打包成可执行文件 (.exe / -mac)

如果你想发给没有安装 Node.js 的朋友使用，本项目已内置 `pkg` 打包脚本。

```bash
# 生成 Windows 64 位单文件程序
npm run build-win

# 生成 Mac 单文件程序
npm run build-mac
```
生成的可执行文件可以拷贝到任何对应平台电脑双击即用（默认 3000 端口）。
注意：同步功能强依赖浏览器引擎，如果是单文件运行且报错，请确保目标机器已安装 Chrome 浏览器或 Playwright 预设。

<details>
<summary><b>pkg 打包兼容性说明</b></summary>
提示：为了完美兼容 `pkg` 对动态加载模块的封装，项目中已将请求库 `axios` 锁定为原生友好的 `0.27.2` 经典版本。请勿轻易升级 axios 版本，否则可能导致 `.exe` 打包后运行时报错找不到模块。
</details>

---

## 🐳 NAS/Docker 远程部署专用版

对于希望在群晖、飞牛 OS 等 NAS 设备或 Linux 服务器上长期运行本工具的用户，本项目提供了一个专门适配远程运行的隔离版本压缩在 `nas-deployment/` 目录中。

**主要特性：**
* 完整移除本地相关依赖，专门针对 Docker 优化（默认绑定 `0.0.0.0`，无 TTY 崩溃问题）
* 自带 `Dockerfile` 与 `docker-compose.yml`，支持一键构建与启动
* 推荐配合飞牛 (FN OS) 的原生 Docker 运行 DDNSTO 进行内网穿透
* 新增通过环境变量 `DOWNLOAD_DIR` 灵活映射物理下载路径
* 已兼容收藏同步与喜欢同步，容器内基于官方 Playwright 镜像运行，无需额外安装浏览器依赖
* `douyin_session.json`、`synced_ids.json`、`liked_ids.json` 与 `user_data/` 均可通过卷挂载持久化，便于飞牛 OS 重启后继续使用
* 前端 UI 专门对移动端浏览器（如 Safari、夸克、UC 等）增加了 **「保存到手机」** 的 HTTP 直接下载适配，自动处理文件名中文乱码与特殊浏览器格式限制问题。

**使用方法：**
进入 `nas-deployment` 目录，通过 `docker build` 或 `docker-compose up -d` 即可部署。该目录不会影响根目录的本地 PC 版使用体验。

`nas-deployment/docker-compose.yml` 默认已示例挂载以下数据：
* 下载目录
* 抖音登录凭证文件 `douyin_session.json`
* 收藏下载状态文件 `synced_ids.json`
* 喜欢下载状态文件 `liked_ids.json`
* Playwright 持久化目录 `user_data/`

---

## ⚙ 技术栈

* **后端**：`Node.js`, `Express`, `Axios`
* **前端**：`Vanilla JavaScript`, `CSS3 Variables`, `HTML5`
* **打包工具**：`pkg`

---

## ⚠️ 免责声明 (Disclaimer)

* 本项目**仅供个人学习、技术研究与编程练习使用**。
* 请遵守国家法律法规及各平台的使用条款，**请勿将本工具用于商业牟利、侵权、非法传播或其他不当用途**。
* 一切因滥用本工具而产生的法律纠纷或平台封禁，开发者概不负责。

---

## 🤝 贡献与支持 (Contributing)

欢迎提交 [Issue](https://github.com/westlifehq/video_downloader/issues) 反馈 Bug 或提交 [Pull Request](https://github.com/westlifehq/video_downloader/pulls) 完善功能。

如果你觉得这个小工具好用，不妨点个 ⭐️ **Star** 支持一下开发者！

---
## 📝 License
[MIT License](LICENSE) © 2024
