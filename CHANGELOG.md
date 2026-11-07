## [v8.7.3] - 2026-11-08

### Fixed
- **底座镜像与 playwright 版本不匹配导致浏览器功能全挂**：`package-lock.json` 锁定 playwright 1.62.1，而 `nas-deployment/Dockerfile` 底座为 `mcr.microsoft.com/playwright:v1.59.1-jammy`（内置 1.59.1 浏览器），运行时按 1.62.1 查找 `chromium_headless_shell-1234` 不存在 → 收藏/喜欢/私信/用户主页同步全部 `Executable doesn't exist`（链接解析因走 axios 分享页通道未受影响，问题被掩盖）。
- **修复**：底座升级 `v1.62.1-jammy`（amd64 + arm64 双架构），`package.json` 将 playwright 由 `^1.59.1` 改为精确 `1.62.1` 锁定，避免 npm 安装再次漂移。

### Verified
- 东京 OCI ARM（aarch64）实测：修复前同步 3 次重试全失败；修复后浏览器正常启动。

### Metadata
- Branch: `main`
- Scope: `nas-deployment/Dockerfile`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`

---

