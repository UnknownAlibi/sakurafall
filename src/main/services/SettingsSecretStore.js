// 设置页敏感项存储（Electron safeStorage）
//
// localStorage 里的 app-settings 是明文：代理地址可能含账号、第三方 API Key
// 也可能被任意读取用户目录的程序拿走。这里把敏感字段拆到 userData 下的
// settings-secrets.json，落盘前用 safeStorage 加密；渲染层仍保留内存中的值，
// 只是不再把明文写进 localStorage。

const fs = require('fs');
const path = require('path');
const { protectValue, revealValue } = require('../utils/secretStore');

const SECRET_FIELDS = Object.freeze([
  'proxy',
  'danmakuCustomToken',
  'dandanplayAppSecret',
  'openSubtitlesApiKey'
]);

const FIELD_LIMITS = Object.freeze({
  proxy: 2048,
  danmakuCustomToken: 4096,
  dandanplayAppSecret: 4096,
  openSubtitlesApiKey: 4096
});

function normalizeSecrets(input = {}) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const field of SECRET_FIELDS) {
    if (!(field in input)) continue;
    // 保留空字符串：表示“已清除该项”，save 时会从文件中删除
    result[field] = String(input[field] || '').trim().slice(0, FIELD_LIMITS[field] || 4096);
  }
  return result;
}

class SettingsSecretStore {
  constructor(options = {}) {
    this.filePath = String(options.filePath || '');
    // 仅测试注入；生产环境传 undefined，让 secretStore 自己解析 Electron safeStorage
    this.adapter = options.adapter;
  }

  _adapter() {
    return this.adapter;
  }

  _readStored() {
    if (!this.filePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object'
        ? parsed.secrets
        : {};
    } catch (_error) {
      return {};
    }
  }

  load() {
    const stored = this._readStored();
    const result = {};
    for (const field of SECRET_FIELDS) {
      const value = stored[field];
      if (typeof value !== 'string' || !value) continue;
      const revealed = revealValue(value, this._adapter());
      // 解不开时不要把手里的密文当成密钥返回给渲染层
      if (revealed === value && value.startsWith('safe:v1:')) continue;
      result[field] = revealed;
    }
    return result;
  }

  save(input = {}) {
    if (!this.filePath) return { success: false, error: '设置密钥存储路径未初始化' };
    const secrets = normalizeSecrets(input);
    // 合并已有字段，避免只更新一个设置时把其它密钥清空；空字符串表示删除。
    const stored = { ...this._readStored() };
    const configured = [];
    for (const [field, value] of Object.entries(secrets)) {
      if (value) {
        stored[field] = protectValue(value, this._adapter());
        configured.push(field);
      } else {
        delete stored[field];
      }
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, secrets: stored }, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
      fs.renameSync(tmpPath, this.filePath);
      return { success: true, configured };
    } catch (error) {
      try { fs.rmSync(`${this.filePath}.tmp`, { force: true }); } catch (_) { /* ignore */ }
      return { success: false, error: error.message };
    }
  }
}

module.exports = {
  SettingsSecretStore,
  SECRET_FIELDS,
  normalizeSecrets
};
