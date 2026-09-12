// 轻量更新检查器
// 从配置的 URL 拉取 latest.json，对比版本号，返回更新信息。
// 不依赖 electron-updater，不需要代码签名，用户只需在静态服务器维护 latest.json。
//
// latest.json 格式：
// {
//   "version": "1.1.0",
//   "downloadUrl": "https://example.com/SakuraFall-Setup-1.1.0.exe",
//   "releaseNotes": "1. 修复 xxx\n2. 新增 yyy",
//   "releaseDate": "2026-06-18",
//   "minRequiredVersion": "1.0.0"  // 可选，低于此版本强制更新
// }

const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const HttpClient = require('../utils/HttpClient');
const { UPDATE_MANIFEST_URL } = require('../config/serviceEndpoints');
const GITHUB_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/UnknownAlibi/sakurafall/main/latest.json';

function safeLog(...args) {
  try { console.log(...args); } catch (e) { /* EPIPE ignored */ }
}
function safeError(...args) {
  try { console.error(...args); } catch (e) { /* EPIPE ignored */ }
}

class UpdateChecker {
  constructor() {
    this.http = new HttpClient({ timeout: 10000 });
    // 默认更新源：主仓库 main 分支的 latest.json（发布流程见 scripts/release.js）
    this.defaultUpdateUrl = UPDATE_MANIFEST_URL || GITHUB_UPDATE_MANIFEST_URL;
    this.fallbackUpdateUrls = [GITHUB_UPDATE_MANIFEST_URL];
    this._config = null;
    // 托管式更新的状态机：idle → downloading → ready → installing / error
    // 状态由主进程持有，渲染进程切换页面不影响下载，任何界面都能经 getUpdateState 恢复显示。
    // 注意：下载完成只停在 ready，安装/重启由用户在全局更新卡片上确认后触发
    // （installManagedUpdate），不再自动重启，避免用户正在看番时被强制打断。
    this._managed = {
        status: 'idle', percent: 0, received: 0, total: 0, filePath: '', error: '',
        latestVersion: '', releaseNotes: ''
    };
    this._lastEmit = 0;
    // 最近一次检查得到的清单内容（下载时用于取 sha256，避免只信渲染层回传）
    this._lastCheck = null;
  }

  setServiceBaseUrl(baseUrl = '') {
    const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
    this.defaultUpdateUrl = normalized
      ? `${normalized}/updates/latest.json`
      : GITHUB_UPDATE_MANIFEST_URL;
    this.fallbackUpdateUrls = normalized ? [GITHUB_UPDATE_MANIFEST_URL] : [];
  }

  _isLocalHttpHost(hostname) {
    return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
  }

  _normalizeSafeHttpUrl(value, label = 'URL') {
    const raw = String(value || '').trim();
    if (!raw) throw new Error(`${label} 为空`);

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      throw new Error(`${label} 格式无效`);
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`${label} 仅支持 http/https`);
    }
    if (parsed.protocol === 'http:' && !this._isLocalHttpHost(parsed.hostname)) {
      throw new Error(`${label} 必须使用 https`);
    }

    parsed.hash = '';
    return parsed.toString();
  }

  normalizeUpdateUrl(url) {
    return this._normalizeSafeHttpUrl(url, '更新源地址');
  }

  normalizeDownloadUrl(url) {
    return this._normalizeSafeHttpUrl(url, '下载链接');
  }

  // 读取用户配置的更新源 URL（存放在 userData/update-config.json）
  _loadConfig() {
    if (this._config !== null) return this._config;
    try {
      const configPath = path.join(app.getPath('userData'), 'update-config.json');
      if (fs.existsSync(configPath)) {
        this._config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } else {
        this._config = {};
      }
    } catch (e) {
      safeError('[UpdateChecker] 读取配置失败:', e.message);
      this._config = {};
    }
    return this._config;
  }

  // 保存更新源 URL
  setUpdateUrl(url) {
    try {
      const updateUrl = this.normalizeUpdateUrl(url);
      const configPath = path.join(app.getPath('userData'), 'update-config.json');
      const config = { ...this._loadConfig(), updateUrl };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      this._config = config;
      safeLog('[UpdateChecker] 更新源已保存:', updateUrl);
      return true;
    } catch (e) {
      safeError('[UpdateChecker] 保存更新源失败:', e.message);
      return false;
    }
  }

  // 获取当前配置的更新源 URL
  getUpdateUrl() {
    const config = this._loadConfig();
    try {
      return this.normalizeUpdateUrl(config.updateUrl || this.defaultUpdateUrl);
    } catch (e) {
      safeError('[UpdateChecker] 更新源无效，已回退默认地址:', e.message);
      return this.defaultUpdateUrl;
    }
  }

  // 获取当前应用版本
  getCurrentVersion() {
    return app.getVersion();
  }

  _updateCandidates() {
    const candidates = [this.getUpdateUrl(), ...this.fallbackUpdateUrls];
    return Array.from(new Set(candidates.filter(Boolean).map(url => this.normalizeUpdateUrl(url))));
  }

  /**
   * 简单的 semver 版本对比
   * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
   */
  _compareVersion(a, b) {
    const parse = (value) => {
      const normalized = String(value || '').trim().replace(/^v/i, '');
      const [core, prerelease = ''] = normalized.split('-', 2);
      return {
        core: core.split('.').map(part => /^\d+$/.test(part) ? Number(part) : 0),
        prerelease: prerelease ? prerelease.split('.').filter(Boolean) : []
      };
    };
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.core.length, pb.core.length);
    for (let i = 0; i < len; i++) {
      const va = pa.core[i] || 0;
      const vb = pb.core[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
    if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
    const preLength = Math.max(pa.prerelease.length, pb.prerelease.length);
    for (let i = 0; i < preLength; i++) {
      const va = pa.prerelease[i];
      const vb = pb.prerelease[i];
      if (va === undefined) return -1;
      if (vb === undefined) return 1;
      if (va === vb) continue;
      const aNumber = /^\d+$/.test(va);
      const bNumber = /^\d+$/.test(vb);
      if (aNumber && bNumber) return Number(va) > Number(vb) ? 1 : -1;
      if (aNumber !== bNumber) return aNumber ? -1 : 1;
      return va > vb ? 1 : -1;
    }
    return 0;
  }

  /**
   * 检查更新
   * @param {object} options - { silent?: boolean } silent=true 时静默检查（启动时用）
   * @returns {object} { hasUpdate, currentVersion, latestVersion, downloadUrl, releaseNotes, releaseDate, forceUpdate, error? }
   */
  async checkForUpdates(options = {}) {
    const currentVersion = this.getCurrentVersion();
    const candidates = this._updateCandidates();
    let lastError = null;

    for (const updateUrl of candidates) {
      try {
        safeLog('[UpdateChecker] 检查更新:', updateUrl);
        const text = await this.http.fetch(updateUrl, {
          timeout: updateUrl === candidates[0] && candidates.length > 1 ? 2500 : 10000
        });
        const data = JSON.parse(text);

        if (!data.version) {
          throw new Error('latest.json 缺少 version 字段');
        }

        const hasUpdate = this._compareVersion(data.version, currentVersion) > 0;
        const minRequiredVersion = data.minRequiredVersion || '';
        const forceUpdate = minRequiredVersion &&
          this._compareVersion(currentVersion, minRequiredVersion) < 0;

        let downloadUrl = '';
        if (data.downloadUrl) {
          try {
            downloadUrl = this.normalizeDownloadUrl(data.downloadUrl);
          } catch (e) {
            safeError('[UpdateChecker] 忽略不安全下载链接:', e.message);
          }
        }

        // 可选：安装包 sha256（64 位十六进制）。格式非法时按「未提供」处理并告警。
        let sha256 = '';
        if (data.sha256) {
          const candidate = String(data.sha256).trim().toLowerCase();
          if (/^[a-f0-9]{64}$/.test(candidate)) {
            sha256 = candidate;
          } else {
            safeError('[UpdateChecker] latest.json 的 sha256 格式非法，已忽略:', String(data.sha256).slice(0, 24));
          }
        }

        const result = {
          hasUpdate,
          currentVersion,
          latestVersion: data.version,
          downloadUrl,
          sha256,
          releaseNotes: data.releaseNotes || '',
          releaseDate: data.releaseDate || '',
          forceUpdate: !!forceUpdate,
          silent: !!options.silent,
          sourceUrl: updateUrl,
          fallbackUsed: updateUrl !== candidates[0]
        };

        // 记住主进程侧的清单内容：下载时优先用这里的摘要，
        // 不依赖渲染层回传（渲染层只负责触发，不该成为校验依据的来源）。
        this._lastCheck = {
          downloadUrl,
          sha256,
          latestVersion: data.version,
          releaseNotes: data.releaseNotes || ''
        };

        safeLog('[UpdateChecker] 检查结果:', hasUpdate ? `发现新版本 ${data.version}` : '已是最新版本');
        return result;
      } catch (error) {
        lastError = error;
        safeError(`[UpdateChecker] 更新源不可用，${updateUrl === candidates[candidates.length - 1] ? '停止检查' : '尝试备用源'}:`, error.message);
      }
    }

    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      error: lastError?.message || '所有更新源均不可用',
      silent: !!options.silent
    };
  }

  /** 更新包落盘目录（同时是安装时的白名单目录） */
  getUpdatesDir() {
    return path.join(app.getPath('userData'), 'updates');
  }

  /** 计算文件 sha256（十六进制小写） */
  _sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /**
   * 应用内下载安装包到 userData/updates/
   * @param {string} url - latest.json 里的 downloadUrl
   * @param {function} onProgress - ({ received, total, percent }) 进度回调
   * @param {{ sha256?: string }} options - manifest 提供的摘要，存在时强制校验
   * @returns {Promise<{ success, path, received, total }|{ success:false, error }>}
   */
  async downloadInstaller(url, onProgress = null, options = {}) {
    try {
      const safeUrl = this.normalizeDownloadUrl(url);
      const dir = this.getUpdatesDir();
      fs.mkdirSync(dir, { recursive: true });
      // 文件名取 URL 尾段，缺省用版本号命名。
      // 必须过 path.basename：尾段可能是解码后的 "../.."（形如 ..%2F..%2Fevil.exe），
      // 直接 join 会逃出 updates 目录，而上一步还会先 rmSync 该路径 —— 等于任意路径删+写。
      const rawTail = decodeURIComponent(new URL(safeUrl).pathname.split('/').pop() || '');
      const tail = path.basename(rawTail.replace(/\\/g, '/'));
      const fileName = /\.exe$/i.test(tail) ? tail : `SakuraFall-Setup-${this.getCurrentVersion()}.exe`;
      const filePath = path.join(dir, fileName);
      // 双保险：解析后必须仍落在 updates 目录内
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
        throw new Error('下载文件名非法，已拒绝写入更新目录之外');
      }
      // 旧的同名残留先清掉，避免断点混淆
      try { fs.rmSync(filePath, { force: true }); } catch (e) { /* ignore */ }
      const report = ({ received, total }) => {
        if (!onProgress) return;
        onProgress({
          received,
          total,
          percent: total ? Math.min(100, Math.floor((received / total) * 100)) : 0
        });
      };
      const result = await this.http.downloadToFile(safeUrl, filePath, {}, report);
      safeLog('[UpdateChecker] 安装包下载完成:', filePath, `${result.received} bytes`);

      // 完整性校验：manifest 带 sha256 时强制比对，不通过就删掉已下载文件
      const expected = String(options.sha256 || '').trim().toLowerCase();
      if (expected) {
        const actual = await this._sha256File(filePath);
        if (actual !== expected) {
          try { fs.rmSync(filePath, { force: true }); } catch (e) { /* ignore */ }
          safeError('[UpdateChecker] 安装包摘要不匹配，已删除:', `期望 ${expected.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
          return { success: false, error: '安装包校验失败（摘要不匹配），已删除下载文件' };
        }
        safeLog('[UpdateChecker] 安装包摘要校验通过');
      } else {
        // 兼容历史 manifest：没有摘要时默认仍允许安装（可通过环境变量收紧）。
        // 注意：若攻击者能改 latest.json，他同样能改/删这里的摘要 —— 摘要只能防
        // 「下载链路被篡改/损坏」，防不了「更新源被拿下」。后者的根治手段是安装包代码签名。
        if (process.env.SAKURAFALL_UPDATE_REQUIRE_HASH === '1') {
          try { fs.rmSync(filePath, { force: true }); } catch (e) { /* ignore */ }
          return { success: false, error: '更新清单缺少 sha256，已按策略拒绝安装' };
        }
        safeError('[UpdateChecker] latest.json 未提供 sha256，本次跳过完整性校验（建议在发布流程中补充）');
      }

      return { success: true, path: filePath, received: result.received, total: result.total, checksum: expected || '' };
    } catch (error) {
      safeError('[UpdateChecker] 下载安装包失败:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 托管式更新（第一步：只下载）
   * 主进程持有下载状态，用户点一次即开始下载；完成后停在 ready 状态等待用户
   * 确认重启安装（见 installManagedUpdate），页面切换/关闭卡片都不会中断下载。
   * @param {string} url - latest.json 里的 downloadUrl
   * @param {function} onEvent - 状态变化回调（节流推送，用于广播到所有窗口）
   * @param {{ latestVersion?: string, releaseNotes?: string }} meta - 供全局卡片展示的版本信息
   * @returns {{ status, percent, received, total, filePath, error, alreadyRunning? }}
   */
  startManagedUpdate(url, onEvent = null, meta = {}) {
    if (this._managed.status === 'downloading' || this._managed.status === 'installing') {
      return { ...this._managed, alreadyRunning: true };
    }
    this._managed = {
      status: 'downloading',
      percent: 0,
      received: 0,
      total: 0,
      filePath: '',
      error: '',
      latestVersion: String(meta.latestVersion || ''),
      releaseNotes: String(meta.releaseNotes || '')
    };
    this._emitState(onEvent, true);
    // 摘要来源优先级：本次清单缓存（URL 一致时）> 调用方传入。
    // 主进程侧缓存更可信，因为渲染层只是触发方。
    const cached = this._lastCheck && this._lastCheck.downloadUrl === url ? this._lastCheck : null;
    const sha256 = cached?.sha256 || String(meta.sha256 || '').trim().toLowerCase();
    this.downloadInstaller(url, p => {
      if (!p) return;
      this._managed.percent = p.percent || 0;
      this._managed.received = p.received || 0;
      this._managed.total = p.total || 0;
      this._emitState(onEvent);
    }, { sha256 }).then(result => {
      if (result.success) {
        // 只到 ready：等用户在全局卡片上点「立即重启安装」
        this._managed.status = 'ready';
        this._managed.percent = 100;
        this._managed.filePath = result.path;
        this._emitState(onEvent, true);
        safeLog('[UpdateChecker] 安装包已就绪，等待用户确认重启安装:', result.path);
      } else {
        this._managed.status = 'error';
        this._managed.error = result.error || '下载失败';
        this._emitState(onEvent, true);
      }
    }).catch(error => {
      this._managed.status = 'error';
      this._managed.error = error?.message || String(error);
      this._emitState(onEvent, true);
    });
    return { ...this._managed };
  }

  /**
   * 托管式更新（第二步：用户确认后安装并重启）
   * 仅在下载完成的 ready 状态下可调用；安装接力进程会等本应用退出后覆盖安装目录并拉起新版。
   * @param {function} onEvent - 状态变化回调
   * @returns {Promise<{ status, error?, alreadyRunning? }>}
   */
  async installManagedUpdate(onEvent = null) {
    if (this._managed.status === 'installing') {
      return { ...this._managed, alreadyRunning: true };
    }
    if (this._managed.status !== 'ready' || !this._managed.filePath) {
      return { ...this._managed, success: false, error: '没有已下载完成的安装包' };
    }
    // 开发模式下 process.execPath 指向 electron 自身的 dist 目录，
    // 覆盖安装会破坏本地开发环境，必须拦掉。
    if (!app.isPackaged) {
      this._managed.status = 'error';
      this._managed.error = '开发模式不支持覆盖安装，请在打包版本中验证';
      this._emitState(onEvent, true);
      safeError('[UpdateChecker] 已拦截开发模式下的安装请求');
      return { ...this._managed, success: false };
    }
    this._managed.status = 'installing';
    this._emitState(onEvent, true);
    // runInstaller 成功时会自行 app.quit()，失败则把状态落到 error
    const installResult = await this.runInstaller(this._managed.filePath);
    if (!installResult?.success) {
      this._managed.status = 'error';
      this._managed.error = installResult?.error || '启动安装程序失败';
      this._emitState(onEvent, true);
    }
    return { ...this._managed };
  }

  // 当前托管更新状态快照（IPC 可安全传输的纯对象）
  getUpdateState() {
    return { ...this._managed };
  }

  _emitState(onEvent, force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 150) return;
    this._lastEmit = now;
    try { onEvent && onEvent({ ...this._managed }); } catch (e) { /* listener died */ }
  }

  /**
   * 运行安装包并退出应用（覆盖安装，用户数据保留在 userData）
   * @param {string} filePath - 下载得到的安装包路径
   * @returns {Promise<{ success, error? }>}
   */
  async runInstaller(filePath) {
    try {
      const resolved = path.resolve(String(filePath || ''));
      // 只接受更新目录内的安装包：filePath 来自主进程下载流程，但多一道目录约束
      // 可以确保「即使上层逻辑被改坏」也不会执行任意路径的 exe。
      const updatesDir = path.resolve(this.getUpdatesDir());
      if (!resolved.startsWith(updatesDir + path.sep)) {
        return { success: false, error: '安装包不在更新目录内，已拒绝执行' };
      }
      if (!fs.existsSync(resolved) || !/\.exe$/i.test(resolved)) {
        return { success: false, error: '安装包不存在或格式无效' };
      }
      const executablePath = path.resolve(process.execPath);
      const installDirectory = path.dirname(executablePath);
      const handoffLog = path.join(path.dirname(resolved), 'install-handoff.log');
      // 让独立 PowerShell 进程先等待当前应用完全退出，再覆盖原安装目录并启动新版。
      // 路径只通过环境变量传入，避免 cmd 多层引号导致命令被吞掉；/D 显式保留
      // 用户选择的安装目录，即使 NSIS 注册表信息丢失也不会装到默认 C 盘。
      const runner = [
        "$ErrorActionPreference = 'Stop'",
        'try {',
        '  Wait-Process -Id ([int]$env:SAKURAFALL_UPDATE_PARENT_PID) -Timeout 120 -ErrorAction SilentlyContinue',
        "  $installerArgs = '/S /D=\"' + $env:SAKURAFALL_UPDATE_INSTALL_DIR + '\"'",
        '  $installer = Start-Process -FilePath $env:SAKURAFALL_UPDATE_INSTALLER -ArgumentList $installerArgs -WindowStyle Hidden -PassThru -Wait',
        "  if ($installer.ExitCode -ne 0) { throw ('Installer exited with code ' + $installer.ExitCode) }",
        '  if (-not (Test-Path -LiteralPath $env:SAKURAFALL_UPDATE_EXECUTABLE)) { throw \'Updated executable is missing\' }',
        '  Start-Process -FilePath $env:SAKURAFALL_UPDATE_EXECUTABLE',
        '} catch {',
        "  ($_ | Out-String) | Set-Content -LiteralPath $env:SAKURAFALL_UPDATE_LOG -Encoding UTF8",
        '}'
      ].join('\n');
      const child = spawn('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-Command', runner
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          SAKURAFALL_UPDATE_PARENT_PID: String(process.pid),
          SAKURAFALL_UPDATE_INSTALLER: resolved,
          SAKURAFALL_UPDATE_INSTALL_DIR: installDirectory,
          SAKURAFALL_UPDATE_EXECUTABLE: executablePath,
          SAKURAFALL_UPDATE_LOG: handoffLog
        }
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      safeLog('[UpdateChecker] 安装接力进程已启动，将覆盖当前目录并自动重启:', installDirectory);
      setTimeout(() => {
        try { app.quit(); } catch (e) { /* ignore */ }
      }, 600);
      return { success: true };
    } catch (error) {
      safeError('[UpdateChecker] 启动安装程序失败:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new UpdateChecker();
module.exports.UpdateChecker = UpdateChecker;
module.exports.GITHUB_UPDATE_MANIFEST_URL = GITHUB_UPDATE_MANIFEST_URL;
