const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const m3u8Parser = require('m3u8-parser');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 配置路径
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'temp');
const HISTORY_FILE = path.join(DOWNLOAD_DIR, 'history.json');

// 确保目录存在
fs.ensureDirSync(DOWNLOAD_DIR);
fs.ensureDirSync(TEMP_DIR);

// 设置 ffmpeg 路径
ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));


function sanitizeFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) return `video_${Date.now()}`;
    return raw;
}

function resolveSavePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return DOWNLOAD_DIR;

    const requested = path.resolve(inputPath);
    const base = path.resolve(DOWNLOAD_DIR);

    if (requested === base || requested.startsWith(base + path.sep)) {
        return requested;
    }

    return DOWNLOAD_DIR;
}

// --- 历史记录管理 ---
async function getHistory() {
    if (await fs.pathExists(HISTORY_FILE)) {
        return await fs.readJson(HISTORY_FILE);
    }
    return [];
}

async function addToHistory(item) {
    try {
        let history = await getHistory();
        history.unshift({
            ...item,
            completedAt: new Date().toISOString()
        });
        if (history.length > 50) history = history.slice(0, 50);
        await fs.writeJson(HISTORY_FILE, history);
    } catch (err) {
        console.error('Failed to save history:', err);
    }
}

// --- 下载任务逻辑 (移植自 main.js) ---
class DownloadTask {
    constructor(id, url, fileName, savePath) {
        this.id = id;
        this.url = url;
        this.fileName = fileName;
        this.savePath = savePath || DOWNLOAD_DIR;
        this.tempDir = path.join(TEMP_DIR, String(id));
        this.downloadedSegments = 0;
        this.totalSegments = 0;
        this.downloadedBytes = 0;
        this.lastSpeedUpdate = Date.now();
        this.lastBytes = 0;
        this.isCancelled = false;
        this.isPaused = false;
        this.pausePromise = null;
        this.pauseResolver = null;
    }

    pause() {
        this.isPaused = true;
        this.log('任务已暂停', 'warn');
        this.pausePromise = new Promise(resolve => {
            this.pauseResolver = resolve;
        });
    }

    resume() {
        if (this.isPaused && this.pauseResolver) {
            this.isPaused = false;
            this.log('任务已恢复', 'info');
            this.pauseResolver();
            this.pausePromise = null;
            this.pauseResolver = null;
        }
    }

    async checkPaused() {
        if (this.isPaused && this.pausePromise) {
            await this.pausePromise;
        }
    }

    cancel() {
        this.isCancelled = true;
        this.resume();
        this.log('任务已手动取消', 'warn');
    }

    log(msg, type = 'info') {
        io.emit('download-log', { id: this.id, text: msg, type });
    }

    progress(phase, percent, speed = '') {
        io.emit('download-progress', {
            id: this.id,
            phase,
            percent,
            current: this.downloadedSegments,
            total: this.totalSegments,
            speed
        });
    }

    error(msg) {
        io.emit('download-error', { id: this.id, message: msg });
    }

    complete(filePath) {
        io.emit('download-complete', { id: this.id, filePath });
        addToHistory({
            id: this.id,
            fileName: this.fileName,
            url: this.url,
            filePath,
            savePath: this.savePath
        });
    }

    updateFileName(newName) {
        if (newName && newName.trim()) {
            this.fileName = newName.trim();
            this.log(`文件名已更新为: ${this.fileName}`);
        }
    }

    async parseM3U8(data) {
        const parser = new m3u8Parser.Parser();
        parser.push(data);
        parser.end();
        return parser.manifest;
    }

    formatSpeed(bytesPerSec) {
        if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
        else if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
        else return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    }

    mergeSegments(fileListPath, outputPath) {
        const createCommand = (mode) => {
            const command = ffmpeg()
                .input(fileListPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .output(outputPath);

            if (mode === 'copy') {
                command.outputOptions([
                    '-c', 'copy',
                    '-bsf:a', 'aac_adtstoasc',
                    '-fflags', '+genpts',
                    '-max_interleave_delta', '0',
                    '-movflags', '+faststart'
                ]);
            } else {
                command.outputOptions([
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-ar', '48000',
                    '-ac', '2',
                    '-movflags', '+faststart'
                ]);
            }

            return command;
        };

        const runCommand = (mode) => new Promise((resolve, reject) => {
            createCommand(mode)
                .on('progress', (progress) => {
                    const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
                    this.progress('merging', percent);
                })
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        return runCommand('copy')
            .catch(async (copyErr) => {
                this.log(`无损合并失败，尝试音频修复模式: ${copyErr.message}`, 'warn');
                await fs.remove(outputPath).catch(() => { });
                return runCommand('audio-fallback');
            });
    }

    async start() {
        try {
            this.log(`正在获取 M3U8: ${this.url}`);
            let m3u8Url = this.url;
            const response = await axios.get(m3u8Url);
            let manifest = await this.parseM3U8(response.data);

            if (!manifest.segments || manifest.segments.length === 0) {
                if (manifest.playlists && manifest.playlists.length > 0) {
                    const subUrl = new URL(manifest.playlists[0].uri, m3u8Url).toString();
                    this.log(`检测到主播放列表，自动选择第一个流: ${subUrl}`);
                    const subRes = await axios.get(subUrl);
                    manifest = await this.parseM3U8(subRes.data);
                    m3u8Url = subUrl;
                    if (!manifest.segments || manifest.segments.length === 0) throw new Error('无法解析视频分片。');
                } else {
                    throw new Error('无效的 M3U8 文件，未找到分片。');
                }
            }

            const isEncrypted = manifest.segments.some(seg => seg.key && seg.key.method && seg.key.method !== 'NONE');
            if (isEncrypted) throw new Error('不支持加密的视频流 (检测到 EXT-X-KEY)。');

            this.totalSegments = manifest.segments.length;
            this.log(`解析成功，共 ${this.totalSegments} 个分片。准备下载...`);
            await fs.ensureDir(this.tempDir);

            const segmentFiles = [];
            const getSegmentUrl = (segUri) => new URL(segUri, m3u8Url).toString();
            const MAX_RETRIES = 3;
            const RETRY_DELAY = 1000;

            const downloadSegmentWithRetry = async (segUrl, filePath, index) => {
                let lastError;
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    try {
                        const writer = fs.createWriteStream(filePath);
                        const response = await axios({
                            url: segUrl,
                            method: 'GET',
                            responseType: 'stream',
                            timeout: 30000
                        });
                        response.data.on('data', (chunk) => { this.downloadedBytes += chunk.length; });
                        response.data.pipe(writer);
                        return new Promise((resolve, reject) => {
                            writer.on('finish', async () => {
                                const stat = await fs.stat(filePath).catch(() => ({ size: 0 }));
                                if (!stat.size) {
                                    return reject(new Error('分片内容为空，可能源站返回异常内容'));
                                }
                                this.downloadedSegments++;
                                const now = Date.now();
                                if (now - this.lastSpeedUpdate > 500) {
                                    const diffBytes = this.downloadedBytes - this.lastBytes;
                                    const diffTime = (now - this.lastSpeedUpdate) / 1000;
                                    const speed = this.formatSpeed(diffBytes / diffTime);
                                    this.lastBytes = this.downloadedBytes;
                                    this.lastSpeedUpdate = now;
                                    const percent = Math.round((this.downloadedSegments / this.totalSegments) * 100);
                                    this.progress('downloading', percent, speed);
                                }
                                resolve();
                            });
                            writer.on('error', reject);
                        });
                    } catch (err) {
                        lastError = err;
                        if (attempt < MAX_RETRIES) {
                            this.log(`分片 ${index} 下载失败 (尝试 ${attempt}/${MAX_RETRIES}): ${err.message}，正在重试...`, 'warn');
                            await new Promise(r => setTimeout(r, RETRY_DELAY));
                        }
                    }
                }
                this.log(`分片 ${index} 下载失败，已尝试 ${MAX_RETRIES} 次: ${lastError.message}`, 'error');
                throw lastError;
            };

            const tasks = manifest.segments.map((seg, index) => async () => {
                const segUrl = getSegmentUrl(seg.uri);
                const fileName = `${index}.ts`;
                const filePath = path.join(this.tempDir, fileName);
                segmentFiles[index] = filePath;
                await downloadSegmentWithRetry(segUrl, filePath, index);
            });

            const batchSize = 10;
            for (let i = 0; i < tasks.length; i += batchSize) {
                await this.checkPaused();
                if (this.isCancelled) {
                    this.error('下载已手动取消');
                    await fs.remove(this.tempDir).catch(console.error);
                    return;
                }
                const batch = tasks.slice(i, i + batchSize).map(t => t());
                await Promise.all(batch);
            }

            this.progress('downloading', 100, '0 KB/s');
            this.log('所有分片下载完成。开始合并...');
            this.progress('merging', 0);

            const fileListPath = path.join(this.tempDir, 'files.txt');
            const fileContent = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
            await fs.writeFile(fileListPath, fileContent);

            const safeName = this.fileName.replace(/[^a-z0-9\u4e00-\u9fa5_\-\.]/gi, '_');
            let outputFileName = `${safeName}.mp4`;
            let finalOutputPath = path.join(this.savePath, outputFileName);
            let counter = 1;
            while (await fs.pathExists(finalOutputPath)) {
                finalOutputPath = path.join(this.savePath, `${safeName}_${counter}.mp4`);
                counter++;
            }

            await this.mergeSegments(fileListPath, finalOutputPath);
            this.log(`合并完成! 文件已保存至: ${finalOutputPath}`, 'success');
            this.complete(finalOutputPath);
            fs.remove(this.tempDir).catch(console.error);
            activeDownloads.delete(this.id);

        } catch (err) {
            this.error(`错误: ${err.message}`);
            fs.remove(this.tempDir).catch(console.error);
            activeDownloads.delete(this.id);
        }
    }
}

const activeDownloads = new Map();

// --- REST API ---
app.post('/api/download/start', async (req, res) => {
    const { url, fileName, savePath } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ message: '参数错误: url 必填且必须是字符串。' });
    }

    const normalizedFileName = sanitizeFileName(fileName);
    const normalizedSavePath = resolveSavePath(savePath);
    await fs.ensureDir(normalizedSavePath);

    const id = Date.now().toString() + Math.random().toString(36).slice(2, 7);
    const task = new DownloadTask(id, url, normalizedFileName, normalizedSavePath);
    activeDownloads.set(id, task);

    io.emit('download-started', { id, url, fileName: normalizedFileName });
    task.start();

    return res.json({ id, url, fileName: normalizedFileName, savePath: normalizedSavePath });
});

app.post('/api/download/pause', (req, res) => {
    const { id } = req.body;
    const task = activeDownloads.get(id);
    if (task) task.pause();
    res.json({ success: !!task });
});

app.post('/api/download/resume', (req, res) => {
    const { id } = req.body;
    const task = activeDownloads.get(id);
    if (task) task.resume();
    res.json({ success: !!task });
});

app.post('/api/download/cancel', (req, res) => {
    const { id } = req.body;
    const task = activeDownloads.get(id);
    if (task) task.cancel();
    activeDownloads.delete(id);
    res.json({ success: !!task });
});

app.post('/api/download/rename', (req, res) => {
    const { id, newName } = req.body;
    const task = activeDownloads.get(id);
    if (task) task.updateFileName(newName);
    res.json({ success: !!task });
});


app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', downloadDir: DOWNLOAD_DIR, tempDir: TEMP_DIR });
});

app.get('/api/history', async (req, res) => {
    const history = await getHistory();
    res.json(history);
});

app.post('/api/history/clear', async (req, res) => {
    await fs.writeJson(HISTORY_FILE, []);
    res.json({ success: true });
});

// 默认路由指向前端
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Downloads will be saved to: ${DOWNLOAD_DIR}`);
});
