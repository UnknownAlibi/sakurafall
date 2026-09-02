const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');

const { WatchTogetherService } = require('../src/main/services/WatchTogetherService');
const { RoomRelay } = require('../server/src/relay');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function collectMessages(service) {
  const received = [];
  service.onMessage((msg) => received.push(msg));
  const waitFor = (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = received.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('等待消息超时: ' + JSON.stringify(received.map(m => m.type))));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
  return { received, waitFor };
}

test('watch together: LAN address selection ignores TUN and virtual adapters', () => {
  const service = new WatchTogetherService({
    relayBaseUrl: '',
    networkInterfacesProvider: () => ({
      singbox_tun: [{ family: 'IPv4', internal: false, address: '172.18.0.1', mac: '00:00:00:00:00:00' }],
      'VMware Network Adapter': [{ family: 'IPv4', internal: false, address: '192.168.129.1', mac: '00:50:56:c0:00:01' }],
      'WLAN 2': [{ family: 'IPv4', internal: false, address: '192.168.0.150', mac: '88:f4:da:9f:fc:d1' }]
    })
  });
  assert.equal(service._getLanAddress(), '192.168.0.150');
});

test('watch together: relay can switch between cloud and local modes', () => {
  const service = new WatchTogetherService({ relayBaseUrl: 'https://service.example.com/' });
  assert.equal(service.relayBaseUrl, 'https://service.example.com');
  service.setRelayBaseUrl('');
  assert.equal(service.relayBaseUrl, '');
  service.setRelayBaseUrl('https://relay.example.com/');
  assert.equal(service.relayBaseUrl, 'https://relay.example.com');
});

test('watch together: member ping echoes pong with identical monotonic timestamp', async () => {
  const port = await getFreePort();

  const host = new WatchTogetherService({ relayBaseUrl: '' });
  host.port = port;
  const member = new WatchTogetherService({ relayBaseUrl: '' });
  member.port = port;

  try {
    const room = await host.createRoom('测试房间', { title: '番剧', episode: 1 });
    assert.equal(room.success, true);
    assert.equal(room.isHost, true);

    // 非成员/未连接时 sendPing 应安全失败
    assert.equal((new WatchTogetherService({ relayBaseUrl: '' })).sendPing(1).success, false);

    const hostInbox = collectMessages(host);
    const memberInbox = collectMessages(member);

    const joined = await member.joinRoom(room.roomCode, '127.0.0.1');
    assert.equal(joined.success, true);
    await memberInbox.waitFor(m => m.type === 'joined');
    assert.equal(memberInbox.received[0].roomCode, room.roomCode);
    assert.equal(memberInbox.received[0].videoInfo.title, '番剧');

    // P1：单调时钟 RTT 探测 —— 主机必须原样回显 ts
    assert.equal(member.sendPing(1234.56).success, true);
    const pong = await memberInbox.waitFor(m => m.type === 'pong');
    assert.equal(pong.ts, 1234.56);
    assert.equal(typeof pong.sentAt, 'number');

    // 主机广播状态，成员收到 sync
    assert.equal(host.broadcastState({ isPlaying: true, currentTime: 42.5, duration: 1440 }).success, true);
    const sync = await memberInbox.waitFor(m => m.type === 'sync');
    assert.equal(sync.state.isPlaying, true);
    assert.equal(sync.state.currentTime, 42.5);
    assert.equal(typeof sync.state.timestamp, 'number');

    // 成员聊天：主机本地回显
    assert.equal(member.sendChat('同步看！').success, true);
    const chat = await hostInbox.waitFor(m => m.type === 'chat');
    assert.equal(chat.text, '同步看！');
    assert.equal(chat.self, undefined);
  } finally {
    host.leaveRoom();
    member.leaveRoom();
    // 等待端口释放，避免影响后续测试
    await new Promise(r => setTimeout(r, 200));
  }
});

test('watch together: chat relays between two members', async () => {
  const port = await getFreePort();

  const host = new WatchTogetherService({ relayBaseUrl: '' });
  host.port = port;
  const memberA = new WatchTogetherService({ relayBaseUrl: '' });
  memberA.port = port;
  const memberB = new WatchTogetherService({ relayBaseUrl: '' });
  memberB.port = port;

  try {
    const room = await host.createRoom('三人房', null);
    await memberA.joinRoom(room.roomCode, '127.0.0.1');
    await memberB.joinRoom(room.roomCode, '127.0.0.1');

    const inboxA = collectMessages(memberA);
    const inboxB = collectMessages(memberB);

    assert.equal(memberA.sendChat('大家好').success, true);
    // 成员 B 应收到主机转发的 A 的聊天，消息不含 self 标记
    const relayed = await inboxB.waitFor(m => m.type === 'chat' && m.text === '大家好');
    assert.equal(relayed.from, memberA.memberId);
    // 发送方 A 不应收到自己的转发（只有本地回显带 self: true）
    await new Promise(r => setTimeout(r, 150));
    const selfEcho = inboxA.received.filter(m => m.type === 'chat' && m.text === '大家好');
    assert.equal(selfEcho.length, 1);
    assert.equal(selfEcho[0].self, true);

    // 成员数应随加入更新（member-joined 在注册监听前已发出，改查房间状态）
    await new Promise(r => setTimeout(r, 150));
    assert.equal(host.getRoomInfo().memberCount, 3);
  } finally {
    host.leaveRoom();
    memberA.leaveRoom();
    memberB.leaveRoom();
    await new Promise(r => setTimeout(r, 200));
  }
});

test('watch together: host leaving closes the room for members', async () => {
  const port = await getFreePort();

  const host = new WatchTogetherService({ relayBaseUrl: '' });
  host.port = port;
  const member = new WatchTogetherService({ relayBaseUrl: '' });
  member.port = port;

  try {
    const room = await host.createRoom('关闭测试', null);
    await member.joinRoom(room.roomCode, '127.0.0.1');

    const inbox = collectMessages(member);
    host.leaveRoom();
    await inbox.waitFor(m => m.type === 'room-closed');

    // 房间关闭后连接断开，再发 ping 应失败而不是悬挂
    await new Promise(r => setTimeout(r, 150));
    const ping = member.sendPing(1);
    assert.equal(ping.success, false);
  } finally {
    host.leaveRoom();
    member.leaveRoom();
    await new Promise(r => setTimeout(r, 200));
  }
});

test('watch together: unavailable relay degrades to a usable LAN room', async () => {
  const relayPort = await getFreePort();
  const localPort = await getFreePort();
  const host = new WatchTogetherService({
    relayBaseUrl: `http://127.0.0.1:${relayPort}`,
    localPort
  });
  const member = new WatchTogetherService({
    relayBaseUrl: 'https://unreachable.example.com',
    localPort
  });
  const memberInbox = collectMessages(member);

  try {
    const room = await host.createRoom('离线局域网房间', { title: '离线番剧' });
    assert.equal(room.success, true);
    assert.equal(room.relay, false);
    assert.equal(room.degraded, true);
    assert.match(room.warning, /局域网/);

    await member.joinRoom(room.roomCode, '127.0.0.1', { forceLocal: true, port: localPort });
    const joined = await memberInbox.waitFor(message => message.type === 'joined');
    assert.equal(joined.videoInfo.title, '离线番剧');

    host.broadcastState({ isPlaying: true, currentTime: 21 });
    const sync = await memberInbox.waitFor(message => message.type === 'sync');
    assert.equal(sync.state.currentTime, 21);
  } finally {
    host.leaveRoom();
    member.leaveRoom();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

test('watch together: central relay creates and joins a room without a host address', async () => {
  const relay = new RoomRelay();
  const server = http.createServer(async (req, res) => {
    const handled = await relay.handleHttp(req, res, new URL(req.url, 'http://localhost'));
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const relayBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const host = new WatchTogetherService({ relayBaseUrl });
  const member = new WatchTogetherService({ relayBaseUrl });
  const hostInbox = collectMessages(host);
  const memberInbox = collectMessages(member);

  try {
    const room = await host.createRoom('中继房间', { title: '测试番剧', episode: 2 });
    assert.equal(room.relay, true);
    assert.match(room.roomCode, /^\d{6}$/);

    const joined = await member.joinRoom(room.roomCode);
    assert.equal(joined.relay, true);
    const joinedMessage = await memberInbox.waitFor(message => message.type === 'joined');
    assert.equal(joinedMessage.videoInfo.title, '测试番剧');

    assert.equal(host.broadcastState({ isPlaying: true, currentTime: 88 }).success, true);
    const sync = await memberInbox.waitFor(message => message.type === 'sync');
    assert.equal(sync.state.currentTime, 88);

    assert.equal(member.sendChat('服务器见').success, true);
    const chat = await hostInbox.waitFor(message => message.type === 'chat');
    assert.equal(chat.text, '服务器见');
    assert.equal(member.getRoomInfo().connected, true);
  } finally {
    host.leaveRoom();
    member.leaveRoom();
    relay.close();
    await new Promise(resolve => server.close(resolve));
  }
});
