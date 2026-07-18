FROM node:20-bookworm-slim

WORKDIR /app

# 使用 Debian slim 运行时，避免 Alpine/musl 与 ffmpeg-static 二进制兼容性问题。

# 复制 package.json
COPY package*.json ./

# 安装依赖
RUN npm ci

# 复制源代码
COPY . .

# 构建前端
RUN npm run build

# 设置环境变量
ENV PORT=3000
ENV DOWNLOAD_DIR=/downloads
ENV TEMP_DIR=/app/temp

# 暴露端口
EXPOSE 3000

# 建立挂载点
VOLUME ["/downloads"]

# 启动服务
CMD ["node", "server.js"]
