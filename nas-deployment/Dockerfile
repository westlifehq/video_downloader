FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# 安装 Node.js 依赖所需的基础工具 (如有必要)
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# 注意：在容器内我们使用 npm ci 安装依赖
RUN npm ci --omit=dev

# 拷贝代码
COPY server.js .
COPY lib/ ./lib/
COPY public/ ./public/

# 环境变量：让代码识别在 Docker 环境运行，且强制无头模式
ENV IS_DOCKER=true
ENV HEADLESS=true

EXPOSE 3000

CMD ["node", "server.js"]
