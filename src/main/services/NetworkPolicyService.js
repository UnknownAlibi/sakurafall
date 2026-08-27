// 网络策略与诊断服务（Phase 7）
// 解决"不开 VPN 访问不到 Bangumi，开 VPN 视频源播放不了"的现实使用场景。
//
// 职责：
// 1. 维护 per-service 网络策略（direct / proxy / system）。
// 2. 提供网络诊断：代理端口可达性、各服务连通性、m3u8 可访问性、出口 IP。
// 3. TUN 模式推断：对比直连路径与代理路径的出口差异。
// 4. 给用户可复制到代理软件的域名建议。
//
// 不直接发起业务请求，诊断时复用各 service 的 test() 方法。

const net = require('net');
const HttpClient = require('../utils/HttpClient');

// 服务标识
const SERVICE_IDS = {
  BANGUMI: 'bangumi',
  CMS: 'cms',
  VIDEO: 'video',
  DANMAKU: 'danmaku',
  TRACE_MOE: 'trace-moe',
  IMAGE: 'image'
};

// 策略模式
const POLICY_MODES = {
  DIRECT: 'direct',   // 直连
  PROXY: 'proxy',     // 使用配置的代理
  SYSTEM: 'system'    // 跟随系统（Electron session）
};

// 默认策略：Bangumi/弹幕/以图搜番/图片走代理，视频源与播放流直连
const DEFAULT_POLICIES = {
  [SERVICE_IDS.BANGUMI]: POLICY_MODES.PROXY,
  [SERVICE_IDS.CMS]: POLICY_MODES.DIRECT,
  [SERVICE_IDS.VIDEO]: POLICY_MODES.DIRECT,
  [SERVICE_IDS.DANMAKU]: POLICY_MODES.PROXY,
  [SERVICE_IDS.TRACE_MOE]: POLICY_MODES.PROXY,
  [SERVICE_IDS.IMAGE]: POLICY_MODES.PROXY
};

// 域名分流建议（给用户复制到代理软件）
const DOMAIN_SUGGESTIONS = [
  {
    group: 'Bangumi（需走代理）',
    domains: ['api.bgm.tv', 'bgm.tv', 'bangumi.tv', 'lain.bgm.tv']
  },
  {
    group: '弹幕 / 以图搜番（需走代理）',
    domains: ['api.dandanplay.net', 'trace.moe']
  }
];

function safeLog(...args) {
  try { console.log(...args); } catch (_) { /* ignore EPIPE */ }
}

class NetworkPolicyService {
  constructor() {
    this.proxyUrl = '';
    this.bangumiApi = null;
    this.cmsApiService = null;
    this.sourceProviderRegistry = null;
    this.danmakuApi = null;
    this.traceMoeApi = null;
    this.imageCacheService = null;
    this.policies = { ...DEFAULT_POLICIES };
    // 诊断用独立 HttpClient（避免污染业务请求的代理状态）
    this._probeClient = new HttpClient({ timeout: 5000 });
  }

  // ===== 依赖注入 =====
  setBangumiApi(api) { this.bangumiApi = api; }
  setCmsApiService(svc) { this.cmsApiService = svc; }
  setSourceProviderRegistry(registry) { this.sourceProviderRegistry = registry; }
  setDanmakuApi(api) { this.danmakuApi = api; }
  setTraceMoeApi(api) { this.traceMoeApi = api; }
  setImageCacheService(svc) { this.imageCacheService = svc; }

  setProxy(proxyUrl) {
    this.proxyUrl = proxyUrl || '';
    // 同步给探测客户端（用于代理端口可达性测试）
    this._probeClient.setProxy(this.proxyUrl);
  }

  setPolicies(policies = {}) {
    this.policies = { ...DEFAULT_POLICIES, ...policies };
  }

  getPolicy(serviceId) {
    return this.policies[serviceId] || POLICY_MODES.DIRECT;
  }

  /**
   * 根据 service 策略解析出实际应使用的代理地址
   * @returns {string} 代理 URL，空字符串表示直连
   */
  resolveProxyForService(serviceId) {
    const mode = this.getPolicy(serviceId);
    if (mode === POLICY_MODES.PROXY) return this.proxyUrl;
    if (mode === POLICY_MODES.SYSTEM) return ''; // 系统策略由 Electron session 处理
    return ''; // DIRECT
  }

  // ===== 域名建议 =====
  getDomainSuggestions() {
    const sourceDomains = new Set();
    for (const provider of this.sourceProviderRegistry?.listProviders?.() || []) {
      const source = this.cmsApiService?.getSourceConfig?.(provider.sourceId);
      try {
        if (source?.api) sourceDomains.add(new URL(source.api).hostname);
      } catch (_) { /* ignore invalid extension data */ }
    }
    for (const resolver of this.sourceProviderRegistry?.sharePageResolver?.listResolvers?.() || []) {
      for (const host of resolver.hosts || []) sourceDomains.add(host);
    }
    return sourceDomains.size > 0
      ? [...DOMAIN_SUGGESTIONS, { group: '已安装播放源（建议直连）', domains: [...sourceDomains] }]
      : DOMAIN_SUGGESTIONS;
  }

  // ===== 诊断 =====

  /**
   * 测试代理端口可达性（TCP connect）
   * @returns {Promise<{ reachable: boolean, elapsedMs: number, error?: string }>}
   */
  testProxyPort() {
    return new Promise((resolve) => {
      if (!this.proxyUrl) {
        resolve({ reachable: false, elapsedMs: 0, error: '未配置代理地址' });
        return;
      }

      let host = '127.0.0.1';
      let port = 7890;
      try {
        const url = new URL(this.proxyUrl);
        host = url.hostname || host;
        port = parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
      } catch (e) {
        resolve({ reachable: false, elapsedMs: 0, error: `代理地址格式无效: ${this.proxyUrl}` });
        return;
      }

      const startedAt = Date.now();
      const socket = new net.Socket();
      const timeout = 3000;

      socket.setTimeout(timeout);
      socket.once('connect', () => {
        const elapsedMs = Date.now() - startedAt;
        socket.destroy();
        resolve({ reachable: true, elapsedMs, host, port });
      });
      socket.once('timeout', () => {
        const elapsedMs = Date.now() - startedAt;
        socket.destroy();
        resolve({ reachable: false, elapsedMs, error: `连接超时（${timeout}ms）` });
      });
      socket.once('error', (error) => {
        const elapsedMs = Date.now() - startedAt;
        resolve({ reachable: false, elapsedMs, error: error.message });
      });

      socket.connect(port, host);
    });
  }

  /**
   * 测试 Bangumi API 连通性（复用 bangumiApi.test）
   */
  async testBangumi() {
    if (!this.bangumiApi) return { ok: false, msg: 'BangumiApi 未注入' };
    const startedAt = Date.now();
    try {
      const result = await this.bangumiApi.test();
      return { ...result, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, msg: error.message, elapsedMs: Date.now() - startedAt };
    }
  }

  /**
   * 测试片源包声明的备用播放源连通性。
   */
  async testPlaybackSource() {
    const provider = this.sourceProviderRegistry?.findProviderByRole?.('fallback-catalog')
      || this.sourceProviderRegistry?.listProviders?.().find(item => item.type === 'cms' && item.enabled);
    if (!provider) return { success: true, skipped: true, message: '未安装播放源' };
    try {
      const startedAt = Date.now();
      const result = await this.sourceProviderRegistry.test(provider.providerId);
      return {
        ...result,
        success: result?.success !== false && result?.ok !== false,
        time: result?.time || (Date.now() - startedAt),
        message: result?.message || result?.msg || provider.name,
        providerId: provider.providerId,
        providerName: provider.name
      };
    } catch (error) {
      return { success: false, time: 0, message: error.message };
    }
  }

  /**
   * 测试弹幕服务连通性
   */
  async testDanmaku() {
    if (!this.danmakuApi?.test) return { ok: false, msg: 'DanmakuApi 不支持 test' };
    try {
      return await this.danmakuApi.test();
    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  /**
   * 测试以图搜番连通性
   */
  async testTraceMoe() {
    if (!this.traceMoeApi?.test) return { ok: false, msg: 'TraceMoeApi 不支持 test' };
    try {
      return await this.traceMoeApi.test();
    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  /**
   * 测试 CMS 全部源（复用 cmsApiService.testAll）
   */
  async testAllCmsSources() {
    if (!this.cmsApiService?.testAll) return [];
    try {
      return await this.cmsApiService.testAll();
    } catch (error) {
      safeLog('[NetworkPolicy] testAllCmsSources 失败:', error.message);
      return [];
    }
  }

  /**
   * 测试 m3u8 流可达性（复用 cmsApiService.probeStreamQuality）
   * @param {string} url - m3u8 地址
   * @param {string} [referer] - Referer
   */
  async testM3u8(url, referer = '') {
    if (!this.cmsApiService?.probeStreamQuality) {
      return { ok: false, msg: 'CmsApiService 不支持 probeStreamQuality' };
    }
    try {
      const result = await this.cmsApiService.probeStreamQuality(url, referer);
      const ok = !result.error && result.source !== 'probe-failed';
      return {
        ok,
        msg: ok ? `${result.width || '?'}x${result.height || '?'} ${result.bitrate || '?'}kbps` : (result.error || '探测失败'),
        width: result.width,
        height: result.height,
        bitrate: result.bitrate
      };
    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  /**
   * 获取出口 IP（直连 vs 代理对比，用于推断 TUN 模式）
   * 使用 https://api.ipify.org（轻量、无副作用）
   */
  async getOutboundIp(useProxy = false) {
    const client = new HttpClient({ timeout: 5000 });
    if (useProxy) client.setProxy(this.proxyUrl);
    try {
      const text = await client.fetch('https://api.ipify.org');
      const ip = String(text || '').trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip)) {
        return { ok: true, ip };
      }
      return { ok: false, ip: '', msg: '返回内容非 IP 格式' };
    } catch (error) {
      return { ok: false, ip: '', msg: error.message };
    }
  }

  /**
   * TUN 模式推断：对比直连出口 IP 与代理出口 IP
   * - 两者都失败：网络完全不通
   * - 直连成功但出口 IP 与代理一致：TUN 接管了所有流量
   * - 直连成功且代理失败：TUN 未启用，但代理端口不可用
   * - 两者都成功且 IP 不同：正常分流（TUN 未启用或配置正确）
   */
  async detectTunMode() {
    const [direct, proxied] = await Promise.all([
      this.getOutboundIp(false),
      this.getOutboundIp(true)
    ]);

    const result = {
      tunSuspected: false,
      direct,
      proxied,
      suggestion: ''
    };

    if (!direct.ok && !proxied.ok) {
      result.tunSuspected = true;
      result.suggestion = '直连与代理均失败，可能是 TUN 模式接管所有流量且路由配置异常，或网络完全断开';
    } else if (direct.ok && proxied.ok && direct.ip === proxied.ip && this.proxyUrl) {
      result.tunSuspected = true;
      result.suggestion = `直连出口 IP 与代理出口 IP 一致（${direct.ip}），疑似 TUN 模式接管所有流量。建议关闭 TUN，保留本地代理端口（${this.proxyUrl}）`;
    } else if (direct.ok && !proxied.ok && this.proxyUrl) {
      result.tunSuspected = false;
      result.suggestion = `代理端口不可用（${proxied.msg}），但直连正常。请检查代理软件是否运行、端口是否正确`;
    } else if (!direct.ok && proxied.ok) {
      result.tunSuspected = false;
      result.suggestion = `直连失败但代理可用（出口 IP：${proxied.ip}）。建议在代理软件中将 Bangumi 域名加入代理规则`;
    } else {
      result.tunSuspected = false;
      result.suggestion = direct.ok && proxied.ok
        ? `网络正常：直连出口 ${direct.ip}，代理出口 ${proxied.ip}，分流工作正常`
        : '网络状态正常';
    }

    return result;
  }

  /**
   * 全链路诊断：一键检测所有网络依赖
   * @returns {Promise<Object>} 诊断报告
   */
  async runFullDiagnostics() {
    const report = {
      startedAt: Date.now(),
      proxyUrl: this.proxyUrl,
      results: {},
      summary: ''
    };

    // 1. 代理端口可达性
    report.results.proxyPort = await this.testProxyPort();

    // 2. 各服务连通性（并行）
    const [bangumi, playbackSource, danmaku, traceMoe, cmsAll] = await Promise.all([
      this.testBangumi(),
      this.testPlaybackSource(),
      this.testDanmaku(),
      this.testTraceMoe(),
      this.testAllCmsSources()
    ]);

    report.results.bangumi = bangumi;
    report.results.playbackSource = playbackSource;
    report.results.danmaku = danmaku;
    report.results.traceMoe = traceMoe;
    report.results.cmsSources = Array.isArray(cmsAll) ? cmsAll : [];

    // 3. TUN 模式推断（仅在配置了代理时执行）
    if (this.proxyUrl) {
      report.results.tunDetection = await this.detectTunMode();
    }

    // 4. 汇总
    const failures = [];
    if (!report.results.proxyPort.reachable && this.proxyUrl) {
      failures.push('代理端口不可达');
    }
    if (!bangumi.ok) failures.push('Bangumi 不可达');
    if (!playbackSource.success) failures.push('播放源不可达');
    if (!danmaku.ok) failures.push('弹幕服务不可达');

    report.summary = failures.length === 0
      ? '所有服务连通正常'
      : `${failures.length} 项异常：${failures.join('、')}`;

    report.elapsedMs = Date.now() - report.startedAt;
    return report;
  }
}

// 导出常量供外部使用
NetworkPolicyService.SERVICE_IDS = SERVICE_IDS;
NetworkPolicyService.POLICY_MODES = POLICY_MODES;
NetworkPolicyService.DEFAULT_POLICIES = DEFAULT_POLICIES;

module.exports = new NetworkPolicyService();
