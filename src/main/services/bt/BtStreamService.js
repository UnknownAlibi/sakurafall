// BT 边播边下服务：主进程内运行 WebTorrent 客户端，
// 通过仅监听 127.0.0.1 的本地 HTTP 服务器，把正在下载的种子按 Range 流式供给播放窗口。
// 说明：webtorrent 为 ESM 包（含顶层 await），必须用动态 import() 加载，不能 require。
const path = require('path');
const fs = require('fs');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.m4v', '.webm', '.mov', '.avi', '.ts', '.m2ts']);

// 本地代理软件常见端口（Clash / Clash Verge / v2rayN / 通用 SOCKS），用于零配置自动探测
const CANDIDATE_PROXY_PORTS = [7890, 7897, 10808, 10809, 1080, 2080];

// 缓存生命周期：下完整的保留 7 天；超容量按最旧淘汰；未下完的下次启动直接清除（无法断点续传）
const RETAIN_DAYS = 7;
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024;
const META_FILE = '.meta.json';

// 公共 tracker：蜜柑解析出的磁力链不带 tr 参数，补充常见公共种子服务器提升节点发现。
// 动漫社区 tracker（bangumi.moe / nyaatracker / acgtracker / dmhy）是蜜柑与动漫花园资源的主要做种处，
// 且 HTTP tracker 走 TCP，在 UDP 被劣化的网络（如大陆直连）下比 UDP tracker 可靠得多，故排在前列。
const DEFAULT_TRACKERS = [
  'udp://tr.bangumi.moe:6969/announce',
  'http://t.nyaatracker.com/announce',
  'http://open.acgtracker.com:10960/announce',
  'http://share.dmhy.org/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce',
  'https://tr.burnabyhighstar.com/announce'
];

function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase());
}

function extractInfoHash(magnet) {
  const match = String(magnet || '').match(/urn:btih:([a-z0-9]{32,40})/i);
  return match ? match[1].toLowerCase() : '';
}

function appendDefaultTrackers(magnet) {
  const raw = String(magnet || '').trim();
  if (!raw.startsWith('magnet:?')) return raw;
  const existing = new Set((raw.match(/tr=([^&]+)/gi) || []).map(item => decodeURIComponent(item.slice(3))));
  const additions = DEFAULT_TRACKERS.filter(tracker => !existing.has(tracker))
    .map(tracker => `tr=${encodeURIComponent(tracker)}`);
  return additions.length > 0 ? `${raw}&${additions.join('&')}` : raw;
}

// 服务器路由：/webtorrent/{infoHash}/{filePath}，路径逐段编码（保留 / 分隔）
function buildStreamUrl(port, infoHash, filePath) {
  const encodedPath = String(filePath || '').split('/').map(encodeURIComponent).join('/');
  return `http://127.0.0.1:${port}/webtorrent/${infoHash}/${encodedPath}`;
}

class BtStreamService {
  constructor({ app }) {
    this.app = app;
    this.client = null;
    this.serverPort = 0;
    this.cacheDir = '';
    this.proxyUrl = '';
    this._trackerAgent = null;
    this._initPromise = null;
    this._quitHookInstalled = false;
    this._meta = { entries: {} };
    this._doneWatched = new Set();
    // 会话内自动探测结果缓存：undefined=未探测过，''=探测无可用代理，非空=探测到的地址。
    // 缓存避免每次 prepare 都重复扫描端口；'' 哨兵值让"探测失败"也只发生一次。
    this._detectedProxy = undefined;
  }

  // 设置代理：HTTP/HTTPS tracker 的 announce 请求经此代理发出（UDP tracker 与 DHT 仍直连）。
  // 大陆直连下 tracker/DHT 基本不可达，但拿到 peer 列表后与节点间的 TCP 数据传输不受影响，
  // 因此只需代理 tracker 发现链路即可恢复边播边下。代理变化时重建客户端使新代理立即生效。
  setProxy(proxyUrl) {
    const raw = String(proxyUrl || '').trim();
    const next = raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? `http://${raw}` : raw;
    if (next === this.proxyUrl) return;
    this.proxyUrl = next;
    if (this.client) this._teardownClient();
  }

  _teardownClient() {
    const client = this.client;
    const agent = this._trackerAgent;
    this.client = null;
    this.serverPort = 0;
    this._initPromise = null;
    this._doneWatched.clear();
    try { client?.destroy(); } catch (_) { /* 进程内销毁，忽略 */ }
    try { agent?.close?.(); } catch (_) { /* 忽略 */ }
    this._trackerAgent = null;
  }

  async _init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._create().catch(error => {
      this._initPromise = null;
      throw error;
    });
    return this._initPromise;
  }

  async _create() {
    const { default: WebTorrent } = await import('webtorrent');
    this.cacheDir = path.join(this.app.getPath('userData'), 'bt-stream-cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this._loadMeta();
    this._cleanupCache();

    // 未显式配置代理时自动探测本地代理软件（v2rayN/Clash 等）。
    // 大陆直连下 tracker/DHT 不可达是常态，多数用户其实开着代理软件却没在应用里填地址——
    // 探测到就直接用，实现"零配置"。显式 setProxy 的值优先于探测结果。
    if (!this.proxyUrl && this._detectedProxy === undefined) {
      this._detectedProxy = await this._detectLocalProxy();
      if (this._detectedProxy) {
        console.log(`[BtStream] 未配置代理，自动使用检测到的本地代理: ${this._detectedProxy}`);
      }
    }
    if (!this.proxyUrl && this._detectedProxy) {
      this.proxyUrl = this._detectedProxy;
    }

    // utp:false 关闭 uTP 监听：Windows 防火墙常拦截 UDP 绑定导致 EACCES 崩溃，TCP 连接已足够
    const trackerOpts = { announce: DEFAULT_TRACKERS };
    const proxyOpts = this._buildTrackerProxyOpts();
    if (proxyOpts) trackerOpts.proxyOpts = proxyOpts;
    this.client = new WebTorrent({ tracker: trackerOpts, utp: false });
    this.client.on('error', error => console.error('[BtStream] client error:', error?.message || error));

    const server = this.client.createServer({ origin: '*' });
    await new Promise((resolve, reject) => {
      // NodeServer 包装对象不继承事件接口，错误监听挂在内部原始 http server 上
      server.server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.serverPort = server.address().port;

    if (!this._quitHookInstalled) {
      this._quitHookInstalled = true;
      this.app.on('will-quit', () => {
        try { this.client?.destroy(); } catch (_) { /* 进程即将退出，忽略 */ }
        try { this._trackerAgent?.close?.(); } catch (_) { /* 忽略 */ }
      });
    }
    return this.client;
  }

  // 探测本地代理软件：并行 TCP 试连常见端口 → 对开放端口发一次真实 tracker 请求验证。
  // 验证必须走真实 announce 而非 ping 通用网站：目标是确认"经此端口能连上 tracker"，
  // 分流型代理可能放行国内站点却墙掉 tracker。整体预算 ~6s（TCP 0.6s 并行 + 每候选 2.5s）。
  async _detectLocalProxy() {
    const net = require('net');
    const probePort = port => new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port, timeout: 600 });
      socket.once('connect', () => { socket.destroy(); resolve(port); });
      socket.once('error', () => resolve(0));
      socket.once('timeout', () => { socket.destroy(); resolve(0); });
    });
    let openPorts = [];
    try {
      openPorts = (await Promise.all(CANDIDATE_PROXY_PORTS.map(probePort))).filter(Boolean);
    } catch (_) { return ''; }
    for (const port of openPorts.slice(0, 3)) {
      const proxyUrl = `http://127.0.0.1:${port}`;
      try {
        const { ProxyAgent } = require('undici');
        const agent = new ProxyAgent({ uri: proxyUrl });
        const ok = await this._probeTrackerThroughAgent(agent);
        try { await agent.close(); } catch (_) { /* 忽略 */ }
        if (ok) return proxyUrl;
      } catch (_) { /* 该候选验证失败，试下一个 */ }
    }
    return '';
  }

  // 通过候选代理请求一次 nyaatracker announce（带最小合法参数），
  // 返回 200 且有响应体即认为该端口可用作 tracker 代理。
  async _probeTrackerThroughAgent(agent) {
    const params = 'info_hash=%01%02%03%04%05%06%07%08%09%0a%0b%0c%0d%0e%0f%10%11%12%13%14'
      + '&peer_id=-TR2940-123456789012&port=6881&uploaded=0&downloaded=0&left=0&compact=1&event=started&numwant=5';
    const res = await fetch(`http://t.nyaatracker.com/announce?${params}`, {
      dispatcher: agent,
      signal: AbortSignal.timeout(2500)
    });
    const body = new Uint8Array(await res.arrayBuffer());
    return res.status === 200 && body.length > 0;
  }

  // 构造 bittorrent-tracker 的 proxyOpts：http/https 代理用 undici ProxyAgent，socks5 用
  // fetch-socks dispatcher。bittorrent-tracker 内部用 global.fetch 请求 HTTP tracker，
  // 会把 httpAgent/httpsAgent 作为 fetch 的 dispatcher 传入（undici 接口），从而实现代理转发。
  _buildTrackerProxyOpts() {
    if (!this.proxyUrl) return null;
    try {
      const url = new URL(this.proxyUrl);
      let agent = null;
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const { ProxyAgent } = require('undici');
        agent = new ProxyAgent({ uri: this.proxyUrl });
      } else if (url.protocol === 'socks:' || url.protocol === 'socks4:' || url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
        const { socksDispatcher } = require('fetch-socks');
        agent = socksDispatcher({
          host: url.hostname,
          port: Number(url.port) || 1080,
          type: url.protocol === 'socks4:' ? 4 : 5
        });
      } else {
        console.error('[BtStream] 不支持的代理协议，BT tracker 保持直连:', url.protocol);
        return null;
      }
      this._trackerAgent = agent;
      // socksProxy:null 是必须的：bittorrent-tracker 的 UDP tracker 对 socksProxy 做
      // JSON.parse(JSON.stringify(...))，undefined 会直接抛 SyntaxError（npm 包 bug）
      return { httpAgent: agent, httpsAgent: agent, socksProxy: null };
    } catch (error) {
      console.error('[BtStream] 代理配置无效，BT tracker 保持直连:', error?.message || error);
      this._trackerAgent = null;
      return null;
    }
  }

  _findTorrent(magnet) {
    const infoHash = extractInfoHash(magnet);
    if (!this.client || !infoHash) return null;
    return this.client.torrents.find(torrent => torrent.infoHash === infoHash) || null;
  }

  // 等待元数据就绪并返回文件列表（不开始下载：deselect 模式，播放哪个文件才下哪个）
  async prepare(magnet, { timeoutMs = 45000 } = {}) {
    const client = await this._init();
    let torrent = this._findTorrent(magnet);
    if (!torrent) {
      torrent = client.add(appendDefaultTrackers(magnet), { path: this.cacheDir, deselect: true });
    }

    if (!torrent.files || torrent.files.length === 0) {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          torrent.off('metadata', onMetadata);
          torrent.off('error', onError);
        };
        const timer = setTimeout(() => {
          cleanup();
          client.remove(torrent.infoHash, () => {});
          // 0 节点说明 tracker/DHT 都没连通（大陆直连常见），与"做种少"区分开给对应指引
          const offline = !torrent.numPeers && torrent.progress === 0;
          reject(new Error(offline
            ? (this.proxyUrl
              ? `未能连接任何 BT 节点：tracker 请求已走代理（${this.proxyUrl}）但仍不可达，请检查代理软件可用性（或改用 TUN 模式）后重试`
              : '未能连接任何 BT 节点：tracker 与 DHT 均不可达，且未检测到本地代理。请启动代理软件（v2rayN/Clash 等）保持开启，或在「设置 → 网络设置」填写代理地址后重试')
            : '连接做种节点超时：该资源做种较少，建议改用「用 BT 客户端打开」完整下载'));
        }, timeoutMs);
        const onMetadata = () => { cleanup(); resolve(); };
        const onError = error => {
          cleanup();
          client.remove(torrent.infoHash, () => {});
          reject(new Error(`种子连接失败：${error?.message || error}`));
        };
        torrent.once('metadata', onMetadata);
        torrent.once('error', onError);
      });
    }
    return this._describeTorrent(torrent);
  }

  _describeTorrent(torrent) {
    const normalize = value => String(value || '').replace(/\\/g, '/');
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      cacheDir: this.cacheDir,
      files: (torrent.files || []).map(file => ({
        path: normalize(file.path),
        name: file.name,
        length: file.length,
        isVideo: isVideoFile(file.name),
        streamUrl: buildStreamUrl(this.serverPort, torrent.infoHash, normalize(file.path))
      }))
    };
  }

  // 选定要播放的文件：仅该文件进入下载队列（HTTP Range 请求会进一步优先当前播放位置的分片）
  async open(magnet, filePath) {
    await this._init();
    const torrent = this._findTorrent(magnet);
    if (!torrent || !torrent.files || torrent.files.length === 0) {
      throw new Error('种子尚未就绪，请重新点击「边播边下」');
    }
    const target = torrent.files.find(file => String(file.path).replace(/\\/g, '/') === String(filePath || ''));
    if (!target) throw new Error('未找到该文件，请重新进入边播边下');
    target.select();
    this._registerDoneWatcher(torrent);
    return {
      infoHash: torrent.infoHash,
      url: buildStreamUrl(this.serverPort, torrent.infoHash, String(target.path).replace(/\\/g, '/')),
      fileName: target.name,
      length: target.length
    };
  }

  // 下载完成时登记缓存元数据（保留期与容量淘汰都依赖它）
  _registerDoneWatcher(torrent) {
    if (!torrent || this._doneWatched.has(torrent.infoHash)) return;
    this._doneWatched.add(torrent.infoHash);
    torrent.once('done', () => {
      this._doneWatched.delete(torrent.infoHash);
      const dirName = this._torrentDirName(torrent);
      if (!dirName) return;
      this._meta.entries[torrent.infoHash] = {
        name: torrent.name || dirName,
        dirName,
        size: torrent.length || 0,
        completedAt: Date.now()
      };
      this._saveMeta();
    });
  }

  // webtorrent 把种子内容存在 cacheDir/{torrent.name}/ 下
  _torrentDirName(torrent) {
    const first = torrent?.files?.[0];
    const dir = String(first?.path || '').replace(/\\/g, '/').split('/')[0];
    return dir && dir !== '.' && dir !== '..' ? dir : String(torrent?.name || '');
  }

  _loadMeta() {
    try {
      const raw = fs.readFileSync(path.join(this.cacheDir, META_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        this._meta = parsed;
      }
    } catch (_) {
      this._meta = { entries: {} };
    }
  }

  _saveMeta() {
    try {
      fs.writeFileSync(path.join(this.cacheDir, META_FILE), JSON.stringify(this._meta), 'utf8');
    } catch (error) {
      console.error('[BtStream] 缓存元数据写入失败:', error?.message || error);
    }
  }

  _removeCacheDir(dirName) {
    const name = String(dirName || '');
    if (!name || name.startsWith('.') || name.includes('..') || /[\\/]/.test(name)) return;
    try {
      fs.rmSync(path.join(this.cacheDir, name), { recursive: true, force: true });
    } catch (error) {
      console.error('[BtStream] 缓存目录删除失败:', name, error?.message || error);
    }
  }

  // 启动时清理：过期的完整缓存 → 容量超限按最旧淘汰 → 未登记的半截目录（无法断点续传）全部删除
  _cleanupCache() {
    const entries = this._meta.entries;
    const now = Date.now();
    for (const [infoHash, entry] of Object.entries(entries)) {
      if (!entry?.completedAt || !entry?.dirName) {
        delete entries[infoHash];
        continue;
      }
      if (now - entry.completedAt > RETAIN_MS) {
        this._removeCacheDir(entry.dirName);
        delete entries[infoHash];
      }
    }

    const survivors = Object.entries(entries)
      .filter(([, entry]) => entry?.completedAt && entry?.dirName)
      .sort((a, b) => a[1].completedAt - b[1].completedAt);
    let total = survivors.reduce((sum, [, entry]) => sum + (entry.size || 0), 0);
    for (const [infoHash, entry] of survivors) {
      if (total <= MAX_CACHE_BYTES) break;
      total -= entry.size || 0;
      this._removeCacheDir(entry.dirName);
      delete entries[infoHash];
    }

    let dirNames = [];
    try {
      dirNames = fs.readdirSync(this.cacheDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
        .map(dirent => dirent.name);
    } catch (_) { /* 目录不可读时跳过孤儿清理 */ }
    const registered = new Set(Object.values(entries).map(entry => entry?.dirName).filter(Boolean));
    for (const name of dirNames) {
      if (!registered.has(name)) this._removeCacheDir(name);
    }
    this._saveMeta();
  }

  getCacheInfo() {
    const all = Object.values(this._meta?.entries || {}).filter(entry => entry?.completedAt);
    return {
      cacheDir: this.cacheDir,
      totalBytes: all.reduce((sum, entry) => sum + (entry.size || 0), 0),
      retainDays: RETAIN_DAYS,
      maxBytes: MAX_CACHE_BYTES,
      entries: all
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, 20)
        .map(entry => ({
          name: entry.name || entry.dirName,
          size: entry.size || 0,
          completedAt: entry.completedAt
        }))
    };
  }

  // 清空全部边播边下缓存：先停掉活动种子并删除其数据，再整体重建缓存目录
  async clearCache() {
    if (this.client) {
      const hashes = this.client.torrents.map(torrent => torrent.infoHash);
      for (const hash of hashes) {
        await new Promise(resolve => this.client.remove(hash, { destroyStore: true }, () => resolve()));
        this._doneWatched.delete(hash);
      }
    }
    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch (error) {
      return { success: false, error: error?.message || '清空缓存失败' };
    }
    this._meta = { entries: {} };
    this._saveMeta();
    return { success: true };
  }

  status(magnet) {
    const torrent = this._findTorrent(magnet);
    if (!torrent) return null;
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      progress: torrent.progress || 0,
      downloaded: torrent.downloaded || 0,
      length: torrent.length || 0,
      downloadSpeed: torrent.downloadSpeed || 0,
      numPeers: torrent.numPeers || 0,
      done: torrent.done === true
    };
  }

  // 停止下载并移除种子（保留已下载文件，缓存目录可直接加入本地媒体库）
  async stop(magnet) {
    const torrent = this._findTorrent(magnet);
    if (!torrent) return { success: true, removed: false };
    await new Promise(resolve => this.client.remove(torrent.infoHash, () => resolve()));
    return { success: true, removed: true };
  }
}

module.exports = {
  BtStreamService,
  DEFAULT_TRACKERS,
  isVideoFile,
  extractInfoHash,
  appendDefaultTrackers,
  buildStreamUrl
};
