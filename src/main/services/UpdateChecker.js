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
const fs = require('fs');
const path = require('path');
const HttpClient = require('../utils/HttpClient');

function safeLog(...args) {
  try { console.log(...args); } catch (e) { /* EPIPE ignored */ }
}
function safeError(...args) {
  try { console.error(...args); } catch (e) { /* EPIPE ignored */ }
}

class UpdateChecker {
  constructor() {
    this.http = new HttpClient({ timeout: 10000 });
    // 默认更新源：官方发布仓库的 latest.json（发布流程见 scripts/release.js）
    this.defaultUpdateUrl = 'https://raw.githubusercontent.com/UnknownAlibi/sakurafall-releases/main/latest.json';
    this._config = null;
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
    const updateUrl = this.getUpdateUrl();

    try {
      safeLog('[UpdateChecker] 检查更新:', updateUrl);
      const text = await this.http.fetch(updateUrl);
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

      const result = {
        hasUpdate,
        currentVersion,
        latestVersion: data.version,
        downloadUrl,
        releaseNotes: data.releaseNotes || '',
        releaseDate: data.releaseDate || '',
        forceUpdate: !!forceUpdate,
        silent: !!options.silent
      };

      safeLog('[UpdateChecker] 检查结果:', hasUpdate ? `发现新版本 ${data.version}` : '已是最新版本');
      return result;
    } catch (error) {
      safeError('[UpdateChecker] 检查更新失败:', error.message);
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        error: error.message,
        silent: !!options.silent
      };
    }
  }
}

module.exports = new UpdateChecker();
