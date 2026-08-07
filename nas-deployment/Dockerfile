FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# 安装 Node.js 依赖所需的基础工具 (如有必要)
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# 基础镜像已预装浏览器于 /ms-playwright，跳过 npm 安装时的浏览器重复下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 注意：本 Dockerfile 从仓库根目录作为构建上下文（docker-compose 中 context: ..）
COPY package*.json ./
RUN npm ci --omit=dev

# 拷贝代码
COPY server.js .
COPY lib/ ./lib/
COPY public/ ./public/
COPY routes/ ./routes/

RUN mkdir -p /app/user_data /downloads && chown -R pwuser:pwuser /app /downloads

# 环境变量：让代码识别在 Docker 环境运行，且强制无头模式
ENV IS_DOCKER=true
ENV HEADLESS=true

USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/" > /dev/null || exit 1

CMD ["node", "server.js"]
