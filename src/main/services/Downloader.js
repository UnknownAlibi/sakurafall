// 番剧下载服务
// 支持 HLS m3u8 下载（优先 ffmpeg，回退到 m3u8 分片下载合并）
// 提供下载队列管理：添加 / 暂停 / 恢复 / 取消 / 删除
// 下载进度通过 onProgress 回调实时上报
// 下载状态持久化到 userData/downloads.json
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

// 下载任务状态枚举
const STATUS = {
    PENDING: 'pending',
    DOWNLOADING: 'downloading',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// 默认并发下载数
const DEFAULT_MAX_CONCURRENT = 2;

// 默认 UA
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

class Downloader {
    constructor(options = {}) {
        // 下载目录（用户数据目录下的 downloads 子目录）
        this.downloadDir = options.downloadDir || '';
        // 状态持久化文件
        this.stateFile = options.stateFile || '';
        // 最大并发下载数
        this.maxConcurrent = Math.max(1, parseInt(options.maxConcurrent, 10) || DEFAULT_MAX_CONCURRENT);
        // 进度回调（task => void）
        this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

        // 任务表：id -> task
        this.tasks = new Map();
        // 正在运行的任务数
        this.activeCount = 0;
        // ffmpeg 可执行文件路径（缓存）
        this._ffmpegPath = null;
        this._ffmpegChecked = false;

        // 状态持久化防抖
        this._saveTimer = null;
        this._saveDelay = 500;

        // 启动时自动加载持久化的状态
        this._loadState();
    }

    // ── 配置 ───────────────────────────────────────

    /**
     * 设置下载目录
     */
    setDownloadDir(dir) {
        if (!dir) return;
        this.downloadDir = dir;
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            console.error('[Downloader] 创建下载目录失败:', e.message);
        }
        this._saveState();
    }

    /**
     * 设置最大并发数
     */
    setMaxConcurrent(max) {
        const next = Math.max(1, parseInt(max, 10) || DEFAULT_MAX_CONCURRENT);
        this.maxConcurrent = next;
        this._scheduleNext();
    }

    /**
     * 设置进度回调
     */
    setOnProgress(fn) {
        this.onProgress = typeof fn === 'function' ? fn : null;
    }

    // ── ffmpeg 探测 ───────────────────────────────────

    /**
     * 探测系统 ffmpeg 路径（结果缓存）
     * @returns {Promise<string>} ffmpeg 路径，未找到返回 ''
     */
    async detectFfmpeg() {
        if (this._ffmpegChecked) return this._ffmpegPath || '';
        this._ffmpegChecked = true;

        // 1) 常见安装路径（Windows 优先，兼容 mac/linux）
        const candidates = [
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'ffmpeg', 'current', 'bin', 'ffmpeg.exe'),
            path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
            '/usr/local/bin/ffmpeg',
            '/usr/bin/ffmpeg',
            '/opt/homebrew/bin/ffmpeg'
        ].filter(Boolean);

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                this._ffmpegPath = candidate;
                return candidate;
            }
        }

        // 2) 回退到 PATH 中的 ffmpeg
        const pathOk = await this._checkCommand('ffmpeg', ['-version']);
        this._ffmpegPath = pathOk ? 'ffmpeg' : '';
        return this._ffmpegPath;
    }

    _checkCommand(command, args) {
        return new Promise((resolve) => {
            try {
                const child = execFile(command, args, { timeout: 5000, windowsHide: true }, (error) => {
                    resolve(!error);
                });
                child.on('error', () => resolve(false));
            } catch (e) {
                resolve(false);
            }
        });
    }

    // ── 队列管理 ──────────────────────────────────────

    /**
     * 添加下载任务
     * @param {Object} info - { anime, episode, url }
     *   anime: { id, name, source, cover }
     *   episode: { title, index, url }
     *   url: m3u8 / mp4 真实地址
     * @returns {Object} 创建的任务对象
     */
    addTask(info = {}) {
        const { anime = {}, episode = {}, url } = info;
        if (!url) {
            const err = new Error('下载地址为空');
            err.code = 'NO_URL';
            throw err;
        }

        const id = this._genId(url, anime.id, episode.index);
        // 已存在同 id 任务：若已完成则重新加入队列，否则直接返回原任务
        const existing = this.tasks.get(id);
        if (existing && existing.status !== STATUS.COMPLETED && existing.status !== STATUS.FAILED) {
            return existing;
        }

        // 计算输出文件名（番剧名 - 第N集.mp4）
        const safeName = this._sanitizeFileName(anime.name || '未知番剧');
        const epLabel = this._buildEpisodeLabel(episode);
        const fileName = `${safeName}${epLabel}.mp4`;

        const task = {
            id,
            url,
            anime: {
                id: anime.id || '',
                name: anime.name || '',
                source: anime.source || '',
                cover: anime.cover || ''
            },
            episode: {
                title: episode.title || '',
                index: typeof episode.index === 'number' ? episode.index : -1,
                url: episode.url || url
            },
            fileName,
            filePath: path.join(this.downloadDir || '', fileName),
            status: existing ? STATUS.PENDING : STATUS.PENDING,
            progress: existing ? 0 : 0,
            speed: 0,
            totalBytes: 0,
            downloadedBytes: 0,
            errorMsg: '',
            createdAt: existing ? existing.createdAt : Date.now(),
            startedAt: 0,
            finishedAt: existing && existing.status === STATUS.COMPLETED ? existing.finishedAt : 0,
            // 内部字段（不持久化）
            _child: null,
            _speedTimer: null,
            _lastBytes: 0,
            _abortFlag: false,
            _pauseResolve: null
        };

        this.tasks.set(id, task);
        this._saveState();
        this._scheduleNext();
        return this._toPublicTask(task);
    }

    /**
     * 暂停任务
     */
    pause(id) {
        const task = this.tasks.get(id);
        if (!task) return null;
        if (task.status !== STATUS.DOWNLOADING && task.status !== STATUS.PENDING) {
            return this._toPublicTask(task);
        }
        task._abortFlag = true;
        this._killChild(task);
        task.status = STATUS.PAUSED;
        task.speed = 0;
        this._clearSpeedTimer(task);
        this._saveState();
        this._notify(task);
        this._scheduleNext();
        return this._toPublicTask(task);
    }

    /**
     * 恢复任务
     */
    resume(id) {
        const task = this.tasks.get(id);
        if (!task) return null;
        if (task.status !== STATUS.PAUSED && task.status !== STATUS.FAILED) {
            return this._toPublicTask(task);
        }
        task.status = STATUS.PENDING;
        task._abortFlag = false;
        task.errorMsg = '';
        this._saveState();
        this._scheduleNext();
        return this._toPublicTask(task);
    }

    /**
     * 取消下载（停止任务但保留记录）
     */
    cancel(id) {
        const task = this.tasks.get(id);
        if (!task) return null;
        task._abortFlag = true;
        this._killChild(task);
        this._clearSpeedTimer(task);
        task.status = STATUS.FAILED;
        task.errorMsg = '已取消';
        task.speed = 0;
        this._saveState();
        this._notify(task);
        this._scheduleNext();
        return this._toPublicTask(task);
    }

    /**
     * 删除任务记录和已下载文件
     */
    remove(id) {
        const task = this.tasks.get(id);
        if (!task) return false;
        task._abortFlag = true;
        this._killChild(task);
        this._clearSpeedTimer(task);

        // 删除已下载文件
        if (task.filePath) {
            try {
                if (fs.existsSync(task.filePath)) {
                    fs.unlinkSync(task.filePath);
                }
            } catch (e) {
                console.error('[Downloader] 删除文件失败:', e.message);
            }
        }

        this.tasks.delete(id);
        this._saveState();
        this._scheduleNext();
        return true;
    }

    /**
     * 获取所有任务（公开字段）
     */
    list() {
        const list = [];
        for (const task of this.tasks.values()) {
            list.push(this._toPublicTask(task));
        }
        // 按创建时间倒序
        list.sort((a, b) => b.createdAt - a.createdAt);
        return list;
    }

    /**
     * 关闭所有任务（应用退出时调用）
     */
    shutdown() {
        for (const task of this.tasks.values()) {
            this._killChild(task);
            this._clearSpeedTimer(task);
            if (task.status === STATUS.DOWNLOADING) {
                task.status = STATUS.PAUSED;
                task.speed = 0;
            }
        }
        this._flushSave();
    }

    // ── 调度执行 ──────────────────────────────────────

    _scheduleNext() {
        if (this.activeCount >= this.maxConcurrent) return;
        // 找到下一个 pending 任务
        for (const task of this.tasks.values()) {
            if (this.activeCount >= this.maxConcurrent) break;
            if (task.status === STATUS.PENDING) {
                this._startTask(task);
            }
        }
    }

    async _startTask(task) {
        task.status = STATUS.DOWNLOADING;
        task.startedAt = Date.now();
        task._abortFlag = false;
        task.errorMsg = '';
        this.activeCount++;
        this._notify(task);

        // 启动速度采样定时器
        this._startSpeedTimer(task);

        try {
            // 确保下载目录存在
            if (this.downloadDir) {
                fs.mkdirSync(this.downloadDir, { recursive: true });
            }

            const ffmpeg = await this.detectFfmpeg();
            if (ffmpeg) {
                await this._downloadWithFfmpeg(task, ffmpeg);
            } else {
                await this._downloadWithM3u8(task);
            }

            // 完成或被取消/暂停
            if (task._abortFlag) {
                // 已被 pause/cancel 处理
                return;
            }
            task.status = STATUS.COMPLETED;
            task.progress = 100;
            task.speed = 0;
            task.finishedAt = Date.now();
            this._clearSpeedTimer(task);
            this._saveState();
            this._notify(task);
        } catch (err) {
            if (task._abortFlag) {
                // pause/cancel 主动终止，错误已被处理
                return;
            }
            console.error('[Downloader] 下载失败:', err.message);
            task.status = STATUS.FAILED;
            task.errorMsg = err.message || '下载失败';
            task.speed = 0;
            this._clearSpeedTimer(task);
            this._saveState();
            this._notify(task);
        } finally {
            this.activeCount--;
            this._scheduleNext();
        }
    }

    // ── ffmpeg 下载 ───────────────────────────────────

    _downloadWithFfmpeg(task, ffmpeg) {
        return new Promise((resolve, reject) => {
            const args = [
                '-y',
                '-hide_banner',
                '-loglevel', 'info',
                '-stats',
                '-i', task.url,
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                task.filePath
            ];

            const child = spawn(ffmpeg, args, { windowsHide: true });
            task._child = child;

            let stderrBuf = '';

            const onStderr = (chunk) => {
                stderrBuf += chunk.toString();
                // 按行解析进度
                let idx;
                while ((idx = stderrBuf.indexOf('\n')) >= 0) {
                    const line = stderrBuf.slice(0, idx);
                    stderrBuf = stderrBuf.slice(idx + 1);
                    this._parseFfmpegLine(task, line);
                }
            };

            child.stderr.on('data', onStderr);
            // 某些版本 ffmpeg 把进度写到 stdout
            child.stdout.on('data', onStderr);

            child.on('error', (err) => {
                task._child = null;
                if (task._abortFlag) {
                    resolve();
                    return;
                }
                reject(err);
            });

            child.on('close', (code) => {
                task._child = null;
                if (task._abortFlag) {
                    resolve();
                    return;
                }
                if (code === 0) {
                    // 标记完成
                    task.progress = 100;
                    resolve();
                } else {
                    reject(new Error(`ffmpeg 退出码 ${code}`));
                }
            });
        });
    }

    /**
     * 解析 ffmpeg 进度行（-stats 输出）
     * 形如：frame=  120 fps= 30 q=-1.0 size=    1024kB time=00:00:05.00 bitrate=...
     */
    _parseFfmpegLine(task, line) {
        if (!line) return;
        const sizeMatch = line.match(/size=\s*(\d+)\s*(kB|MB|GB)/i);
        const timeMatch = line.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);

        // 总时长只在首次出现时记录
        if (durMatch && !task._durationSecs) {
            const h = parseInt(durMatch[1], 10);
            const m = parseInt(durMatch[2], 10);
            const s = parseFloat(durMatch[3]);
            task._durationSecs = h * 3600 + m * 60 + s;
        }

        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[2].toUpperCase();
            const bytes = unit === 'KB' ? num * 1024
                : unit === 'MB' ? num * 1024 * 1024
                : unit === 'GB' ? num * 1024 * 1024 * 1024
                : num;
            task.downloadedBytes = bytes;
            task.totalBytes = task.totalBytes || bytes;
        }

        if (timeMatch && task._durationSecs) {
            const h = parseInt(timeMatch[1], 10);
            const m = parseInt(timeMatch[2], 10);
            const s = parseFloat(timeMatch[3]);
            const cur = h * 3600 + m * 60 + s;
            const pct = Math.min(99, Math.max(0, Math.round((cur / task._durationSecs) * 100)));
            task.progress = pct;
        } else if (sizeMatch && task.totalBytes) {
            // 没有时长信息时用字节数估算
            task.progress = Math.min(99, Math.round((task.downloadedBytes / task.totalBytes) * 100));
        }

        // 不要每行都通知（太频繁），速度定时器会统一上报
    }

    // ── m3u8 分片下载（ffmpeg 不可用时的回退方案）────────

    async _downloadWithM3u8(task) {
        const url = task.url;
        if (!/\.m3u8(\?|$)/i.test(url) && !/^data:/i.test(url)) {
            // 非 m3u8 地址（mp4 等）：直接 HTTP 下载
            await this._downloadDirectFile(task);
            return;
        }

        // 1) 获取 m3u8 内容
        const m3u8Text = await this._fetchText(url);
        // 2) 如果是 master playlist，取第一个 variant
        let segments = this._parseM3u8Segments(m3u8Text);
        if (segments.length === 0 && m3u8Text.includes('#EXT-X-STREAM-INF')) {
            const variantUrl = this._pickFirstVariant(m3u8Text);
            if (variantUrl) {
                const variantText = await this._fetchText(variantUrl);
                segments = this._parseM3u8Segments(variantText);
            }
        }

        if (segments.length === 0) {
            throw new Error('m3u8 解析失败：未找到分片');
        }

        // 3) 临时分片目录
        const tmpDir = path.join(this.downloadDir, '.tmp', task.id);
        fs.mkdirSync(tmpDir, { recursive: true });

        // 4) 已下载分片索引（支持断点续传）
        let startIdx = 0;
        const completed = task._completedSegments || 0;
        startIdx = completed;
        task.totalBytes = task.totalBytes || 0;

        const segFileList = [];
        for (let i = 0; i < segments.length; i++) {
            if (task._abortFlag) {
                throw new Error('已取消');
            }
            const segPath = path.join(tmpDir, `seg_${String(i).padStart(6, '0')}.ts`);
            if (i < startIdx && fs.existsSync(segPath)) {
                segFileList.push(segPath);
                continue;
            }
            const segUrl = this._resolveUrl(segments[i], url);
            await this._downloadFile(segUrl, segPath, task);
            task._completedSegments = i + 1;
            segFileList.push(segPath);
            task.progress = Math.min(99, Math.round(((i + 1) / segments.length) * 100));
        }

        if (task._abortFlag) {
            throw new Error('已取消');
        }

        // 5) 合并分片（流式异步写入，避免大文件同步 I/O 阻塞 Electron 主进程）
        const outPath = task.filePath;
        const outFile = await fs.promises.open(outPath, 'w');
        try {
            for (const segPath of segFileList) {
                const input = fs.createReadStream(segPath);
                for await (const chunk of input) {
                    if (task._abortFlag) {
                        input.destroy();
                        throw new Error('已取消');
                    }
                    await outFile.write(chunk);
                }
            }
        } finally {
            await outFile.close();
        }

        // 6) 清理临时分片
        this._rmrf(tmpDir);

        task.progress = 100;
        task._completedSegments = 0;
    }

    /**
     * 直接下载 mp4 等非 m3u8 文件
     */
    async _downloadDirectFile(task) {
        const tmpPath = task.filePath + '.part';
        await this._downloadFile(task.url, tmpPath, task);
        if (task._abortFlag) throw new Error('已取消');
        fs.renameSync(tmpPath, task.filePath);
        task.progress = 100;
    }

    /**
     * 下载单个文件（支持进度回调）
     */
    _downloadFile(url, destPath, task) {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            const client = url.startsWith('https') ? https : http;

            const req = client.get(url, {
                headers: { 'User-Agent': DEFAULT_UA, 'Referer': this._guessReferer(url) },
                timeout: 30000
            }, (res) => {
                // 处理重定向
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close();
                    try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
                    const nextUrl = this._resolveUrl(res.headers.location, url);
                    this._downloadFile(nextUrl, destPath, task).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    file.close();
                    try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const total = parseInt(res.headers['content-length'], 10) || 0;
                if (total) task.totalBytes = total;

                let received = 0;
                res.on('data', (chunk) => {
                    if (task._abortFlag) {
                        req.destroy();
                        file.close();
                        try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
                        reject(new Error('已取消'));
                        return;
                    }
                    received += chunk.length;
                    task.downloadedBytes += chunk.length;
                    if (total) {
                        task.progress = Math.min(99, Math.round((received / total) * 100));
                    }
                });
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => resolve());
                });
            });

            req.on('error', (err) => {
                file.close();
                try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy(new Error('请求超时'));
            });
        });
    }

    // ── m3u8 解析工具 ─────────────────────────────────

    _fetchText(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, {
                headers: { 'User-Agent': DEFAULT_UA, 'Referer': this._guessReferer(url) },
                timeout: 15000
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const nextUrl = this._resolveUrl(res.headers.location, url);
                    this._fetchText(nextUrl).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('请求超时')));
        });
    }

    _parseM3u8Segments(text) {
        const lines = text.split(/\r?\n/);
        const segs = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            // 非注释行视为分片 URI
            segs.push(trimmed);
        }
        return segs;
    }

    _pickFirstVariant(text) {
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const next = (lines[i + 1] || '').trim();
                if (next) return next;
            }
        }
        return '';
    }

    _resolveUrl(maybeRel, base) {
        try {
            return new URL(maybeRel, base).toString();
        } catch (_) {
            return maybeRel;
        }
    }

    _guessReferer(url) {
        try {
            const u = new URL(url);
            return `${u.protocol}//${u.host}/`;
        } catch (_) {
            return '';
        }
    }

    // ── 速度采样 ──────────────────────────────────────

    _startSpeedTimer(task) {
        this._clearSpeedTimer(task);
        task._lastBytes = task.downloadedBytes || 0;
        task._speedTimer = setInterval(() => {
            if (task.status !== STATUS.DOWNLOADING) {
                task.speed = 0;
                return;
            }
            const cur = task.downloadedBytes || 0;
            const delta = cur - task._lastBytes;
            task._lastBytes = cur;
            task.speed = Math.max(0, delta); // bytes/sec（间隔 1s）
            this._notify(task);
        }, 1000);
        if (task._speedTimer.unref) task._speedTimer.unref();
    }

    _clearSpeedTimer(task) {
        if (task._speedTimer) {
            clearInterval(task._speedTimer);
            task._speedTimer = null;
        }
    }

    // ── 子进程管理 ────────────────────────────────────

    _killChild(task) {
        if (!task._child) return;
        try {
            task._child.kill('SIGKILL');
        } catch (_) { /* ignore */ }
        task._child = null;
    }

    _rmrf(dir) {
        try {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const full = path.join(dir, entry);
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    this._rmrf(full);
                } else {
                    fs.unlinkSync(full);
                }
            }
            fs.rmdirSync(dir);
        } catch (_) { /* ignore */ }
    }

    // ── 持久化 ────────────────────────────────────────

    _loadState() {
        if (!this.stateFile) return;
        try {
            if (!fs.existsSync(this.stateFile)) return;
            const text = fs.readFileSync(this.stateFile, 'utf8');
            const data = JSON.parse(text || '{}');
            // 恢复下载目录
            if (data.downloadDir) {
                this.downloadDir = data.downloadDir;
            }
            // 恢复任务列表
            const tasks = Array.isArray(data.tasks) ? data.tasks : [];
            for (const t of tasks) {
                if (!t.id) continue;
                // 之前正在下载的，启动时重置为暂停态
                let status = t.status;
                if (status === STATUS.DOWNLOADING) status = STATUS.PAUSED;
                const restored = {
                    ...t,
                    status,
                    speed: 0,
                    errorMsg: status === STATUS.FAILED ? (t.errorMsg || '') : '',
                    _child: null,
                    _speedTimer: null,
                    _lastBytes: 0,
                    _abortFlag: false,
                    _completedSegments: 0
                };
                this.tasks.set(t.id, restored);
            }
        } catch (e) {
            console.error('[Downloader] 加载状态失败:', e.message);
        }
    }

    _saveState() {
        if (!this.stateFile) return;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._flushSave(), this._saveDelay);
        if (this._saveTimer.unref) this._saveTimer.unref();
    }

    _flushSave() {
        if (!this.stateFile) return;
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        try {
            const data = {
                downloadDir: this.downloadDir,
                tasks: Array.from(this.tasks.values()).map(t => this._toPersistTask(t))
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.error('[Downloader] 保存状态失败:', e.message);
        }
    }

    _toPersistTask(task) {
        return {
            id: task.id,
            url: task.url,
            anime: task.anime,
            episode: task.episode,
            fileName: task.fileName,
            filePath: task.filePath,
            status: task.status,
            progress: task.progress,
            totalBytes: task.totalBytes,
            downloadedBytes: task.downloadedBytes,
            errorMsg: task.errorMsg,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt
        };
    }

    /**
     * 转为对外公开的任务对象（剔除内部字段）
     */
    _toPublicTask(task) {
        return {
            id: task.id,
            url: task.url,
            anime: task.anime,
            episode: task.episode,
            fileName: task.fileName,
            filePath: task.filePath,
            status: task.status,
            progress: task.progress || 0,
            speed: task.speed || 0,
            totalBytes: task.totalBytes || 0,
            downloadedBytes: task.downloadedBytes || 0,
            errorMsg: task.errorMsg || '',
            createdAt: task.createdAt || 0,
            startedAt: task.startedAt || 0,
            finishedAt: task.finishedAt || 0
        };
    }

    _notify(task) {
        if (this.onProgress) {
            try { this.onProgress(this._toPublicTask(task)); } catch (_) { /* ignore */ }
        }
    }

    _genId(url, animeId, epIndex) {
        const raw = `${animeId || ''}|${epIndex ?? ''}|${url || ''}`;
        return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
    }

    _sanitizeFileName(name) {
        return String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '未知番剧';
    }

    _buildEpisodeLabel(episode) {
        if (!episode) return '';
        // 优先用 title，其次用 "第N集"
        if (episode.title) {
            const t = String(episode.title).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40);
            return ` - ${t}`;
        }
        if (typeof episode.index === 'number' && episode.index >= 0) {
            return ` - 第${episode.index + 1}集`;
        }
        return '';
    }
}

Downloader.STATUS = STATUS;

module.exports = Downloader;
