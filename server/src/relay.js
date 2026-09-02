const crypto = require('node:crypto');
const { sendJson, readBody } = require('./httpUtils');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let cursor = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    cursor = 4;
  } else if (length === 127) {
    if (buffer.length < 10 || buffer.readUInt32BE(2) !== 0) return null;
    length = buffer.readUInt32BE(6);
    cursor = 10;
  }
  let mask;
  if (masked) {
    if (buffer.length < cursor + 4) return null;
    mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
  }
  if (length > 64 * 1024) throw new Error('websocket message is too large');
  if (buffer.length < cursor + length) return null;
  const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
  if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload, frameEnd: cursor + length };
}

function buildFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.closeNotified = false;
    this.onMessage = null;
    this.onClose = null;
    socket.on('data', chunk => this._data(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length > 0) {
        const frame = parseFrame(this.buffer);
        if (!frame) return;
        this.buffer = this.buffer.subarray(frame.frameEnd);
        if (frame.opcode === 0x1) this.onMessage?.(frame.payload.toString('utf8'));
        else if (frame.opcode === 0x8) this.close();
        else if (frame.opcode === 0x9) this.socket.write(buildFrame(0xA, frame.payload));
      }
    } catch (_) { this.close(); }
  }

  send(value) {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(buildFrame(0x1, value));
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(buildFrame(0x8, '')); } catch (_) { this.socket.destroy(); }
    this._notifyClosed();
  }

  _closed() {
    this.closed = true;
    this._notifyClosed();
  }

  _notifyClosed() {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onClose?.();
  }
}

class RoomRelay {
  constructor(options = {}) {
    this.rooms = new Map();
    this.roomTtlMs = options.roomTtlMs || 30 * 60_000;
    this.maxMembers = options.maxMembers || 24;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  _roomCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(crypto.randomInt(100000, 1000000));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate room code');
  }

  createRoom(input = {}) {
    const roomCode = this._roomCode();
    const hostToken = crypto.randomBytes(24).toString('base64url');
    this.rooms.set(roomCode, {
      roomCode,
      hostToken,
      roomName: String(input.roomName || '一起看').slice(0, 80),
      videoInfo: input.videoInfo && typeof input.videoInfo === 'object' ? input.videoInfo : null,
      host: null,
      members: new Map(),
      lastActiveAt: Date.now()
    });
    return { roomCode, hostToken, roomName: this.rooms.get(roomCode).roomName };
  }

  async handleHttp(req, res, url) {
    if (url.pathname === '/v1/rooms' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        sendJson(res, 201, this.createRoom(body));
      } catch (error) {
        sendJson(res, 400, { error: 'invalid_room_request', message: error.message });
      }
      return true;
    }
    if (/^\/v1\/rooms\/\d{6}$/.test(url.pathname) && req.method === 'GET') {
      const room = this.rooms.get(url.pathname.split('/').pop());
      if (!room) sendJson(res, 404, { error: 'room_not_found' });
      else sendJson(res, 200, {
        roomCode: room.roomCode,
        roomName: room.roomName,
        videoInfo: room.videoInfo,
        hostConnected: !!room.host,
        memberCount: room.members.size + (room.host ? 1 : 0)
      });
      return true;
    }
    return false;
  }

  handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { socket.destroy(); return; }
    if (url.pathname !== '/ws') return false;
    const room = this.rooms.get(url.searchParams.get('roomCode'));
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'member';
    const memberId = String(url.searchParams.get('memberId') || crypto.randomUUID()).slice(0, 80);
    if (!room || !req.headers['sec-websocket-key']) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (role === 'host' && url.searchParams.get('token') !== room.hostToken) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (role === 'member' && room.members.size >= this.maxMembers) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return true;
    }
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_MAGIC)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'));
    const peer = new Peer(socket);
    peer.memberId = memberId;
    peer.role = role;
    this._attach(room, peer);
    if (head?.length) peer._data(head);
    socket.resume();
    return true;
  }

  _attach(room, peer) {
    room.lastActiveAt = Date.now();
    if (peer.role === 'host') {
      room.host?.close();
      room.host = peer;
    } else {
      room.members.get(peer.memberId)?.close();
      room.members.set(peer.memberId, peer);
    }
    peer.onMessage = text => this._message(room, peer, text);
    peer.onClose = () => this._detach(room, peer);
    peer.send(JSON.stringify({
      type: 'joined',
      roomCode: room.roomCode,
      roomName: room.roomName,
      videoInfo: room.videoInfo,
      memberCount: room.members.size + (room.host ? 1 : 0),
      hostConnected: !!room.host,
      isHost: peer.role === 'host',
      timestamp: Date.now()
    }));
    if (peer.role === 'host') this._broadcast(room, { type: 'host-connected' }, peer);
    this._broadcast(room, {
      type: 'member-count',
      memberCount: room.members.size + (room.host ? 1 : 0)
    });
  }

  _message(room, peer, text) {
    room.lastActiveAt = Date.now();
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ping') {
      peer.send(JSON.stringify({ type: 'pong', ts: message.ts ?? null, sentAt: Date.now() }));
      return;
    }
    message.from = peer.memberId;
    message.isHost = peer.role === 'host';
    message.timestamp = Number(message.timestamp) || Date.now();
    if (peer.role === 'host') {
      if (message.type === 'sync' && message.state) room.lastState = message.state;
      this._broadcast(room, message, peer);
    } else if (message.type === 'chat') {
      message.text = String(message.text || '').slice(0, 500);
      this._broadcast(room, message, peer);
    } else if (message.type === 'state') {
      room.host?.send(JSON.stringify(message));
    }
  }

  _broadcast(room, message, except = null) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (room.host && room.host !== except) room.host.send(text);
    for (const member of room.members.values()) if (member !== except) member.send(text);
  }

  _detach(room, peer) {
    if (peer.role === 'host' && room.host === peer) {
      room.host = null;
      this._broadcast(room, { type: 'host-disconnected' });
    } else if (room.members.get(peer.memberId) === peer) {
      room.members.delete(peer.memberId);
    }
    room.lastActiveAt = Date.now();
    this._broadcast(room, {
      type: 'member-count',
      memberCount: room.members.size + (room.host ? 1 : 0)
    });
  }

  cleanup(now = Date.now()) {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (!room.host && now - room.lastActiveAt > this.roomTtlMs) {
        for (const member of room.members.values()) member.close();
        this.rooms.delete(code);
        removed += 1;
      }
    }
    return removed;
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) {
      room.host?.close();
      for (const member of room.members.values()) member.close();
    }
    this.rooms.clear();
  }
}

module.exports = { RoomRelay, Peer, parseFrame, buildFrame };
