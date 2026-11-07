## [v8.7.2] - 2026-11-08

### Fixed
- **小红书短链在海外/机房 IP 下误判落地页**：PC UA 会被 302 到登录页或 404 错误页，而这两类 URL 的查询参数（redirectPath、noteId）同样包含 `discovery/item`、`noteId=`，使 `extractNoteIdFromUrl` 误判为已落地笔记页，跳过移动端 UA 回退，直接拿登录页/404 页 HTML 解析并报"无法解析页面数据"。现命中 `/login`、`/404`、`errorCode=-` 时一律视为拦截页，继续移动端 UA 重试。
- 实测（东京 OCI ARM）：修复前 PC UA 落地 `rednote.com/404?...errorCode=-510000` 导致解析必失败；修复后可正确落到 `discovery/item` 页面。

### Notes
- 该修复不改变小红书对机房 IP 的响应策略：东京 IP 下移动端页面仅为客户端壳（`__INITIAL_STATE__` 约 4.9KB，不含笔记数据），解析仍需国内出口 IP。

### Metadata
- Branch: `main`
- Scope: `lib/xhs.js`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`

---

