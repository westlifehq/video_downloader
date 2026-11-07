/**
 * 浏览器代理注入（跨机房部署时让 Chromium 走指定出口）
 *
 * 背景：部署在海外机房（如东京 OCI）时，直连抖音会被识别为机房 IP 触发风控；
 * 通过 BROWSER_PROXY 指向国内家宽代理，使浏览器出口与家庭网络一致。
 *
 * 环境变量：
 *   BROWSER_PROXY        形如 http://host:port（为空则不启用代理）
 *   BROWSER_PROXY_BYPASS 逗号分隔的直连地址，默认本机
 *
 * 注意：axios 侧直接读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量，无需此处处理。
 */
function applyProxy(options = {}) {
  const server = (process.env.BROWSER_PROXY || '').trim();
  if (!server) return options;
  const bypass = (process.env.BROWSER_PROXY_BYPASS || '127.0.0.1,localhost').trim();
  return { ...options, proxy: { server, bypass } };
}

module.exports = { applyProxy };
