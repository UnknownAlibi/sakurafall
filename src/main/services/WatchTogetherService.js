// 一起看（同步播放）服务
//
// 简化版 P2P 同步方案：
//   - 主机模式：在本机启动 WebSocket 服务器（端口 9876），广播播放状态给所有成员
//   - 成员模式：作为 WebSocket 客户端连接到主机，接收主机状态并同步本地播放器
//
// 由于项目未依赖 `ws` 包，这里使用 Node.js 原生 http + crypto 模块
// 实现一个最小可用的 WebSocket 协议（RFC 6455 子集）：
//   - 完成 HTTP Upgrade 握手
//   - 解析/构造数据帧（仅支持文本帧，掩码可选）
//   - 处理 close / ping / pong 控制帧
//
// 消息类型：
//   - joined         主机 -> 新成员，包含房间信息
//   - member-joined  主机 -> 全体，有新成员加入
//   - member-left    主机 -> 全体，有成员离开
//   - sync           主机 -> 全体，周期性同步播放状态
//   - chat           双向，聊天消息
//   - room-closed    主机 -> 全体，房间已关闭
//   - reconnecting   本地事件，客户端正在重连
//   - disconnected   本地事件，客户端断开
//   - left           本地事件，已主动离开房间
//   - error          本地事件，发生错误

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PORT = 9876;

// ============================================================
// WebSocket 帧编解码
// ============================================================

/**
 * 从 buffer 偏移 0 处尝试解析一个完整帧
 * 成功返回 { fin, opcode, payload, frameEnd }，数据不足返回 null
 */
function parseFrame(buffer) {
    if (buffer.length < 2) return null;
    const b0 = buffer[0];
    const b1 = buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let cursor = 2;

    if (payloadLen === 126) {
        if (buffer.length < cursor + 2) return null;
        payloadLen = buffer.readUInt16BE(cursor);
        cursor += 2;
    } else if (payloadLen === 127) {
        if (buffer.length < cursor + 8) return null;
        // 仅支持 32 位长度（足够本场景使用）
        const high = buffer.readUInt32BE(cursor);
        if (high > 0) return null;
        payloadLen = buffer.readUInt32BE(cursor + 4);
        cursor += 8;
    }

    let maskKey = null;
    if (masked) {
        if (buffer.length < cursor + 4) return null;
        maskKey = buffer.slice(cursor, cursor + 4);
        cursor += 4;
    }

    if (buffer.length < cursor + payloadLen) return null;

    let payload = buffer.slice(cursor, cursor + payloadLen);
    if (masked) {
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
    }

    return { fin, opcode, payload, frameEnd: cursor + payloadLen };
}

/**
 * 构造一个 WebSocket 数据帧
 * @param {number} opcode 0x1=text, 0x8=close, 0x9=ping, 0xA=pong
 * @param {string|Buffer} payload
 * @param {boolean} mask 是否掩码（客户端发送需要掩码）
 */
function buildFrame(opcode, payload, mask = false) {
    const payloadBuf = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(String(payload), 'utf8');
    const len = payloadBuf.length;
    const frames = [];

    if (len < 126) {
        const header = Buffer.alloc(2);
        header[0] = 0x80 | opcode; // FIN=1
        header[1] = len;
        frames.push(header);
    } else if (len < 65536) {
        const header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
        frames.push(header);
    } else {
        const header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
        frames.push(header);
    }

    if (mask) {
        const maskKey = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) {
            masked[i] = payloadBuf[i] ^ maskKey[i % 4];
        }
        frames.push(maskKey, masked);
    } else {
        frames.push(payloadBuf);
    }

    return Buffer.concat(frames);
}

// ============================================================
// WebSocket 连接包装（服务端/客户端共用）
// ============================================================

class WebSocketConnection {
    constructor(socket, isClient) {
        this.socket = socket;
        this.isClient = !!isClient;
        this.buffer = Buffer.alloc(0);
        this.alive = true;
        this.onMessage = null; // (text:string) => void
        this.onClose = null;   // () => void
        this.onError = null;   // (err:Error) => void

        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', (err) => this._onError(err));
    }

    _onData(chunk) {
        if (!this.alive) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        // 限制缓冲区大小，避免恶意客户端撑爆内存
        if (this.buffer.length > 8 * 1024 * 1024) {
            this._onError(new Error('帧缓冲区过大'));
            this.close();
            return;
        }

        while (this.buffer.length > 0) {
            const frame = parseFrame(this.buffer);
            if (!frame) break; // 数据不足，等待更多

            this.buffer = this.buffer.slice(frame.frameEnd);

            switch (frame.opcode) {
                case 0x0: // continuation
                case 0x1: // text
                case 0x2: // binary
                    if (frame.fin && this.onMessage) {
                        this.onMessage(frame.payload.toString('utf8'));
                    }
                    break;
                case 0x8: // close
                    this.alive = false;
                    try { this.socket.end(); } catch (_) { /* ignore */ }
                    return;
                case 0x9: // ping -> pong
                    this._rawWrite(buildFrame(0xA, frame.payload, this.isClient));
                    break;
                case 0xA: // pong
                    // 忽略
                    break;
                default:
                    break;
            }
        }
    }

    _onClose() {
        if (this.alive) {
            this.alive = false;
        }
        if (this.onClose) this.onClose();
    }

    _onError(err) {
        if (this.onError) this.onError(err);
    }

    _rawWrite(buf) {
        if (!this.alive) return false;
        try {
            this.socket.write(buf);
            return true;
        } catch (e) {
            this.alive = false;
            return false;
        }
    }

    send(text) {
        if (!this.alive) return false;
        return this._rawWrite(buildFrame(0x1, text, this.isClient));
    }

    close() {
        if (!this.alive) return;
        this.alive = false;
        try { this._rawWrite(buildFrame(0x8, '', this.isClient)); } catch (_) { /* ignore */ }
        try { this.socket.end(); } catch (_) { /* ignore */ }
    }
}

// ============================================================
// 一起看服务主体
// ============================================================

class WatchTogetherService {
    constructor() {
        // 主机模式：HTTP/WS 服务器与已连接成员
        this.httpServer = null;
        this.hostConnections = new Set();

        // 成员模式：连接到主机的 WS 客户端
        this.clientSocket = null;

        // 房间状态
        this.roomCode = null;
        this.roomName = '';
        this.isHost = false;
        this.videoInfo = null;
        this.hostAddress = 'localhost';
        this.port = DEFAULT_PORT;
        this.memberId = String(Date.now().toString(36)) + Math.floor(Math.random() * 1e6).toString(36);
        this.memberCount = 1;

        // 消息回调
        this.messageCallbacks = new Set();

        // 重连相关
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    // ── 内部工具 ──────────────────────────────────────

    _emit(msg) {
        for (const cb of this.messageCallbacks) {
            try { cb(msg); } catch (_) { /* ignore */ }
        }
    }

    _generateRoomCode() {
        // 6 位数字房间号
        return String(Math.floor(100000 + Math.random() * 900000));
    }

    // ── 公共 API ──────────────────────────────────────

    /**
     * 创建房间（主机模式）
     * @param {string} roomName 房间名
     * @param {Object} videoInfo 视频信息 { title, url, anime, episode }
     */
    async createRoom(roomName, videoInfo) {
        // 已在房间中则先离开
        if (this.roomCode) this.leaveRoom();

        this.roomCode = this._generateRoomCode();
        this.roomName = roomName || '一起看';
        this.isHost = true;
        this.videoInfo = videoInfo || null;
        this.memberCount = 1;

        await this._startWsServer();

        return {
            success: true,
            roomCode: this.roomCode,
            roomName: this.roomName,
            port: this.port,
            isHost: true,
            memberId: this.memberId,
            memberCount: this.memberCount,
            videoInfo: this.videoInfo
        };
    }

    /**
     * 加入房间（成员模式）
     * @param {string} roomCode 房间号
     * @param {string} [hostAddress] 主机地址（默认 localhost）
     */
    async joinRoom(roomCode, hostAddress = 'localhost') {
        if (this.roomCode) this.leaveRoom();

        this.roomCode = String(roomCode || '').trim();
        this.isHost = false;
        this.hostAddress = String(hostAddress || 'localhost').trim();
        this.memberCount = 1;
        this.videoInfo = null;

        await this._connectClient();
        return {
            success: true,
            roomCode: this.roomCode,
            isHost: false,
            memberId: this.memberId,
            hostAddress: this.hostAddress
        };
    }

    /**
     * 离开房间
     */
    leaveRoom() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;

        if (this.isHost) {
            this._stopWsServer();
        } else {
            this._disconnectClient();
        }

        const wasInRoom = !!this.roomCode;
        this.roomCode = null;
        this.roomName = '';
        this.isHost = false;
        this.videoInfo = null;
        this.memberCount = 1;

        if (wasInRoom) this._emit({ type: 'left' });
        return { success: true, wasInRoom };
    }

    /**
     * 广播播放状态（仅主机可用）
     * @param {Object} state { isPlaying, currentTime, duration, episodeIndex, episodeTitle, playbackRate }
     */
    broadcastState(state) {
        if (!this.isHost || !this.roomCode) {
            return { success: false, error: '当前不是主机或未在房间中' };
        }
        const msg = JSON.stringify({
            type: 'sync',
            state: Object.assign({}, state, { timestamp: Date.now() })
        });
        let sent = 0;
        for (const ws of this.hostConnections) {
            if (ws.send(msg)) sent++;
        }
        return { success: true, sent };
    }

    /**
     * 发送聊天消息
     */
    sendChat(text) {
        const content = String(text || '').slice(0, 500);
        if (!content) return { success: false, error: '消息为空' };
        if (!this.roomCode) return { success: false, error: '未在房间中' };

        const localMsg = {
            type: 'chat',
            from: this.memberId,
            isHost: this.isHost,
            text: content,
            timestamp: Date.now(),
            self: true
        };

        const remoteMsg = JSON.stringify({
            type: 'chat',
            from: this.memberId,
            isHost: this.isHost,
            text: content,
            timestamp: Date.now()
        });

        if (this.isHost) {
            // 主机：广播给所有成员，本地直接回显
            for (const ws of this.hostConnections) {
                ws.send(remoteMsg);
            }
            this._emit(localMsg);
        } else if (this.clientSocket && this.clientSocket.alive) {
            this.clientSocket.send(remoteMsg);
            this._emit(localMsg);
        } else {
            return { success: false, error: '未连接到主机' };
        }
        return { success: true };
    }

    /**
     * 查询当前房间信息
     */
    getRoomInfo() {
        return {
            roomCode: this.roomCode,
            roomName: this.roomName,
            isHost: this.isHost,
            videoInfo: this.videoInfo,
            hostAddress: this.hostAddress,
            port: this.port,
            memberId: this.memberId,
            memberCount: this.memberCount,
            connected: this.isHost
                ? !!this.httpServer
                : !!(this.clientSocket && this.clientSocket.alive)
        };
    }

    /**
     * 注册消息回调
     * @returns {Function} 取消注册函数
     */
    onMessage(callback) {
        if (typeof callback !== 'function') return () => {};
        this.messageCallbacks.add(callback);
        return () => this.messageCallbacks.delete(callback);
    }

    // ── 主机模式：WS 服务器 ──────────────────────────

    _startWsServer() {
        return new Promise((resolve, reject) => {
            this.httpServer = http.createServer((req, res) => {
                // 普通 HTTP 健康检查：返回房间基本信息
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    roomCode: this.roomCode,
                    roomName: this.roomName,
                    memberCount: this.memberCount
                }));
            });

            this.httpServer.on('upgrade', (req, socket, head) => {
                this._handleUpgrade(req, socket, head);
            });

            this.httpServer.on('error', (err) => {
                console.error('[WatchTogether] WS 服务器错误:', err.message);
            });

            const listenPort = this.port;
            this.httpServer.listen(listenPort, '0.0.0.0', () => {
                console.log(`[WatchTogether] 主机已启动，监听端口 ${listenPort}，房间号 ${this.roomCode}`);
                resolve();
            });

            this.httpServer.once('error', (err) => {
                this.httpServer = null;
                reject(err);
            });
        });
    }

    _handleUpgrade(req, socket, _head) {
        const key = req.headers['sec-websocket-key'];
        if (!key) {
            socket.destroy();
            return;
        }

        // 校验房间号（URL query 中携带）
        let requestRoomCode = '';
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            requestRoomCode = url.searchParams.get('roomCode') || '';
        } catch (_) { /* ignore */ }

        if (requestRoomCode && this.roomCode && requestRoomCode !== this.roomCode) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n房间号不匹配');
            socket.destroy();
            return;
        }

        const acceptKey = crypto
            .createHash('sha1')
            .update(key + WS_MAGIC)
            .digest('base64');
        const responseHeaders = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey}`
        ];
        socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

        const ws = new WebSocketConnection(socket, false);
        ws.onMessage = (text) => this._onHostMessage(ws, text);
        ws.onClose = () => {
            this.hostConnections.delete(ws);
            this.memberCount = this.hostConnections.size + 1;
            this._emit({ type: 'member-left', memberCount: this.memberCount });
        };
        ws.onError = (err) => {
            console.error('[WatchTogether] 成员连接错误:', err.message);
            this.hostConnections.delete(ws);
            this.memberCount = this.hostConnections.size + 1;
        };

        this.hostConnections.add(ws);
        this.memberCount = this.hostConnections.size + 1;

        // 向新成员发送房间信息
        ws.send(JSON.stringify({
            type: 'joined',
            roomCode: this.roomCode,
            roomName: this.roomName,
            videoInfo: this.videoInfo,
            memberCount: this.memberCount,
            timestamp: Date.now()
        }));

        // 通知所有成员更新成员数
        this._broadcastMeta({
            type: 'member-joined',
            memberCount: this.memberCount
        });
    }

    _onHostMessage(ws, text) {
        let msg;
        try { msg = JSON.parse(text); } catch (_) { return; }

        if (msg.type === 'chat') {
            // 转发给其他成员
            for (const other of this.hostConnections) {
                if (other !== ws) other.send(text);
            }
            // 主机本地接收
            this._emit(msg);
        } else if (msg.type === 'state') {
            // 成员上报状态（简化版中通常忽略，主机是唯一时钟源）
            this._emit(msg);
        }
    }

    _broadcastMeta(meta) {
        const text = JSON.stringify(meta);
        for (const ws of this.hostConnections) {
            ws.send(text);
        }
        this._emit(meta);
    }

    _stopWsServer() {
        // 通知所有成员房间关闭
        this._broadcastMeta({ type: 'room-closed' });
        for (const ws of this.hostConnections) {
            try { ws.close(); } catch (_) { /* ignore */ }
        }
        this.hostConnections.clear();

        if (this.httpServer) {
            try { this.httpServer.close(); } catch (_) { /* ignore */ }
            this.httpServer = null;
        }
    }

    // ── 成员模式：WS 客户端 ──────────────────────────

    _connectClient() {
        return new Promise((resolve, reject) => {
            this._connectClientImpl(resolve, reject);
        });
    }

    _connectClientImpl(resolve, reject) {
        if (!this.roomCode || this.isHost) {
            reject(new Error('未配置房间或当前为主机'));
            return;
        }

        const key = crypto.randomBytes(16).toString('base64');
        const path = `/?roomCode=${encodeURIComponent(this.roomCode)}&memberId=${encodeURIComponent(this.memberId)}`;

        const req = http.request({
            hostname: this.hostAddress,
            port: this.port,
            path,
            method: 'GET',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': key
            },
            timeout: 5000
        });

        let settled = false;

        req.on('upgrade', (res, socket, _head) => {
            if (settled) return;
            const ws = new WebSocketConnection(socket, true);
            ws.onMessage = (text) => {
                let msg;
                try { msg = JSON.parse(text); } catch (_) { return; }
                if (msg.type === 'joined') {
                    this.memberCount = msg.memberCount || 1;
                    if (msg.videoInfo) this.videoInfo = msg.videoInfo;
                    if (msg.roomName) this.roomName = msg.roomName;
                }
                this._emit(msg);
            };
            ws.onClose = () => {
                this.clientSocket = null;
                this._emit({ type: 'disconnected' });
                // 房间未主动离开时尝试重连
                if (this.roomCode && !this.isHost) {
                    this._scheduleReconnect();
                }
            };
            ws.onError = (err) => {
                console.error('[WatchTogether] 客户端连接错误:', err.message);
            };

            this.clientSocket = ws;
            this.reconnectAttempts = 0;
            settled = true;
            resolve();
        });

        req.on('error', (err) => {
            if (settled) return;
            console.error('[WatchTogether] 连接主机失败:', err.message);
            if (!this.roomCode || this.isHost) return;

            // 不阻塞调用方，在后台尝试重连
            settled = true;
            this._scheduleReconnect();
            resolve();
        });

        req.on('timeout', () => {
            req.destroy(new Error('连接超时'));
        });

        req.end();
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this._emit({ type: 'error', message: '重连失败，已达到最大重试次数' });
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(1000 * this.reconnectAttempts, 5000);
        this._emit({
            type: 'reconnecting',
            attempt: this.reconnectAttempts,
            delay
        });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.roomCode || this.isHost) return;
            this._connectClientImpl(() => {}, () => {});
        }, delay);
    }

    _disconnectClient() {
        if (this.clientSocket) {
            try { this.clientSocket.close(); } catch (_) { /* ignore */ }
            this.clientSocket = null;
        }
    }

    // ── 应用退出时清理 ────────────────────────────────

    shutdown() {
        this.leaveRoom();
    }
}

// 导出单例 + 类
const watchTogetherService = new WatchTogetherService();

module.exports = watchTogetherService;
module.exports.WatchTogetherService = WatchTogetherService;
module.exports.WebSocketConnection = WebSocketConnection;
module.exports.parseFrame = parseFrame;
module.exports.buildFrame = buildFrame;
