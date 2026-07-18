# M3U8 极速下载器 (M3U8 Downloader)

![Icon](./build/icon.png)

一款基于 Electron + React 开发的高性能 M3U8 视频下载工具。支持多任务并发、实时速度显示、自定义文件名及保存路径，并集成了 FFmpeg 自动合并功能。

## ✨ 功能特性

- **🚀 多任务并发**：支持同时下载多个 M3U8 视屏，独立进度条管理。
- **⚡ 实时测速**：实时显示当前下载速度 (KB/s, MB/s)。
- **📂 有序管理**：
  - **自定义文件名**：下载前指定文件名，或使用默认时间戳。
  - **动态重命名**：下载过程中（合并前）可随时点击标题修改文件名。
  - **自定义保存位置**：灵活选择文件保存目录。
- **🎥 自动合并**：下载完成后自动使用内置 FFmpeg 将 TS 分片合并为 MP4 文件。
- **🛡️ 合并容错**：优先无损合并（`-c copy`），遇到异常会自动切换“音频修复模式”（转 AAC）降低音频缺失风险。
- **🎨 现代界面**：玻璃拟态风格 UI，带有平滑动画和明亮动感的视觉效果。

## 🛠️ 技术栈

- **Frontend**: React, Vite, CSS Modules
- **Backend**: Electron, Node.js
- **Media Processing**: `fluent-ffmpeg`, `ffmpeg-static`, `m3u8-parser`
- **Network**: `axios`

## 📦 安装与运行

### 1. 克隆项目
```bash
git clone https://github.com/su469843/M3U8-Downloader.git
cd m3u8-downloader
```

### 2. 安装依赖
```bash
npm install
```

### 3. 开发模式运行
```bash
npm run electron:dev
```

### 4. 打包构建
为您的操作系统生成安装包：
```bash
npm run electron:build
```
构建产物将位于 `dist_electron` 目录。


### 5. Docker 运行（推荐服务器模式）
> Docker 中建议使用 **Web 服务模式**（`server.js`），不建议在容器内运行 Electron GUI。

```bash
# 方式 A：直接 Docker
docker build -t m3u8-downloader .
docker run --rm -p 3000:3000 -v $(pwd)/downloads:/downloads m3u8-downloader

# 方式 B：docker compose（推荐云端/服务器）
docker compose up -d --build
```

项目已内置可直接创建容器的 `docker-compose.yml`：

```yaml
services:
  m3u8-downloader:
    build:
      context: .
      dockerfile: Dockerfile
    image: m3u8-downloader:local
    container_name: m3u8-downloader
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      DOWNLOAD_DIR: /downloads
      TEMP_DIR: /tmp/m3u8-temp
      NODE_ENV: production
    volumes:
      - ./downloads:/downloads
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
    restart: unless-stopped
```

常用容器命令：
```bash
# 后台构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止并删除容器（保留 ./downloads 文件）
docker compose down
```

启动后访问：`http://localhost:3000`

健康检查：
```bash
curl http://localhost:3000/api/health
```



## 💾 最低内存与设备建议（Docker Web 模式）

> 说明：以下为本项目基于 `server.js`（Node.js + FFmpeg）在 **1 个下载任务** 场景下的实测级经验值，实际取决于视频码率、分片数量、磁盘/网络性能。

- **可启动最低配置（不建议长期）**：
  - 内存：**512MB**
  - CPU：1 vCPU
  - 结果：服务通常可启动并下载小文件，但在网络抖动或多任务时容易 OOM / 卡顿。
- **稳定可用配置（推荐下限）**：
  - 内存：**1GB**
  - CPU：1~2 vCPU
  - 结果：单任务下载+合并基本稳定，适合轻量家庭服务器。
- **多任务更流畅配置（推荐）**：
  - 内存：**2GB+**
  - CPU：2 vCPU+
  - 结果：可同时跑多个任务，日志与前端响应更平滑。

### 适合运行的设备

- **低功耗盒子 / 软路由（x86/ARM）**：如 N100/N5105 小主机、树莓派 4/5（建议 4GB 及以上）。
- **NAS**：群晖/威联通中支持 Docker 的机型（建议至少 1GB 可用内存给容器）。
- **云服务器**：1C1G 可作为起步，2C2G 体验更好。
- **普通 PC / 笔记本**：几乎都能流畅运行。

### 速度说明（“应该很快吗？”）

- 项目下载阶段主要受 **源站限速 + 你本机网络 + 磁盘写入** 影响。
- 本项目合并阶段使用 `ffmpeg -c copy`（不转码），CPU 压力相对较低，通常很快。
- 如果你追求更稳：优先给容器 **1GB+ 内存**，并将下载目录挂到本机 SSD。

## 🧩 项目结构

- `electron/` - Electron 主进程 (`main.js`) 和预加载脚本 (`preload.js`)。
- `src/` - React 前端代码 (`App.jsx`, `index.css`)。
- `build/` - 构建资源（如图标）。
- `.github/workflows/` - GitHub Actions 自动构建工作流。

## 📝 使用指南

1.  **输入链接**：在输入框中粘贴 M3U8 地址。
2.  **设置（可选）**：
    - 输入想要的文件名。
    - 点击文件夹图标选择保存位置（默认为系统“下载”文件夹）。
3.  **开始**：点击“开始下载”。
4.  **管理**：
    - 鼠标悬停在任务标题上点击 ✎ 可修改文件名。
    - 点击任务右下角的“显示日志”查看详细进度。
    - 下载完成后点击“打开文件”直接定位到视频。

## 📄 License

Apache-2.0
