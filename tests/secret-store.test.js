const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  protectValue,
  revealValue,
  protectSourcePackSecrets,
  revealSourcePackSecrets
} = require('../src/main/utils/secretStore');
const { SettingsSecretStore } = require('../src/main/services/SettingsSecretStore');

// 测试用假适配器：把 safeStorage 的 Buffer 语义最小化复现，无需真实 Electron
const fakeStorage = {
  encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, '')
};

test('protectValue 加密字面量并保留 ${ENV:} 引用', () => {
  const protectedSecret = protectValue('literal-secret', fakeStorage);
  assert.match(protectedSecret, /^safe:v1:/);
  assert.doesNotMatch(protectedSecret, /literal-secret/);
  assert.equal(revealValue(protectedSecret, fakeStorage), 'literal-secret');

  // 环境变量引用本身就是安全的，不应被加密
  assert.equal(protectValue('${ENV:EMBY_KEY}', fakeStorage), '${ENV:EMBY_KEY}');
  assert.equal(revealValue('${ENV:EMBY_KEY}', fakeStorage), '${ENV:EMBY_KEY}');

  // 空值原样返回
  assert.equal(protectValue('', fakeStorage), '');
});

test('revealValue 兼容改造前的明文与不可解密的数据', () => {
  assert.equal(revealValue('plain-text-secret', fakeStorage), 'plain-text-secret');
  assert.equal(revealValue('safe:v1:bm90LWEtY2lwaGVy', { decryptString: () => { throw new Error('bad key'); } }), 'safe:v1:bm90LWEtY2lwaGVy');
  // 无适配器（纯 node）时保持原值，至少不丢数据
  assert.equal(revealValue('safe:v1:abc', null), 'safe:v1:abc');
  assert.equal(protectValue('literal-secret', null), 'literal-secret');
});

test('源包内媒体库凭据加解密且不修改原对象', () => {
  const pack = {
    kind: 'sakurafall.source-pack',
    apiVersion: 1,
    metadata: { id: 'demo', name: 'Demo' },
    content: {
      cmsSources: [],
      xpathRules: [],
      resolvers: [],
      mediaLibraries: [
        { id: 'jelly', type: 'jellyfin', baseUrl: 'http://127.0.0.1:8096', apiKey: 'literal-secret' },
        { id: 'emby', type: 'emby', baseUrl: 'http://127.0.0.1:8097', apiKey: '${ENV:EMBY_KEY}' }
      ]
    }
  };

  const stored = protectSourcePackSecrets(pack, fakeStorage);
  assert.equal(pack.content.mediaLibraries[0].apiKey, 'literal-secret', '原始对象不应被就地改写');
  assert.doesNotMatch(JSON.stringify(stored), /literal-secret/, '落盘 JSON 不应出现明文');
  assert.equal(stored.content.mediaLibraries[1].apiKey, '${ENV:EMBY_KEY}');

  // 读回（JSON 文本 → 明文），供 MediaLibraryService 正常使用
  const restored = revealSourcePackSecrets(JSON.stringify(stored), fakeStorage);
  assert.equal(restored.content.mediaLibraries[0].apiKey, 'literal-secret');
  assert.equal(restored.content.mediaLibraries[1].apiKey, '${ENV:EMBY_KEY}');
  assert.equal(restored.metadata.id, 'demo');
});

test('revealSourcePackSecrets 对非 JSON 输入保持原样', () => {
  assert.equal(revealSourcePackSecrets('not-json', fakeStorage), 'not-json');
});

test('SettingsSecretStore: 设置密钥加密落盘、支持部分更新与清除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-settings-secrets-'));
  const filePath = path.join(dir, 'settings-secrets.json');
  const store = new SettingsSecretStore({ filePath, adapter: fakeStorage });
  try {
    const saved = store.save({
      proxy: 'http://user:pass@127.0.0.1:7890',
      openSubtitlesApiKey: 'opensubtitles-key',
      unknownField: 'must-not-be-written'
    });
    assert.equal(saved.success, true);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(raw, /user:pass/, '代理密码不能明文落盘');
    assert.doesNotMatch(raw, /opensubtitles-key/, 'API Key 不能明文落盘');
    assert.doesNotMatch(raw, /unknownField/, '未知字段必须被丢弃');
    assert.match(raw, /safe:v1:/, '应使用 safeStorage 前缀');

    let loaded = store.load();
    assert.equal(loaded.proxy, 'http://user:pass@127.0.0.1:7890');
    assert.equal(loaded.openSubtitlesApiKey, 'opensubtitles-key');
    assert.equal(loaded.dandanplayAppSecret, undefined);

    // 部分更新只改指定字段，不清空已有密钥
    store.save({ dandanplayAppSecret: 'dandan-secret' });
    loaded = store.load();
    assert.equal(loaded.proxy, 'http://user:pass@127.0.0.1:7890');
    assert.equal(loaded.openSubtitlesApiKey, 'opensubtitles-key');
    assert.equal(loaded.dandanplayAppSecret, 'dandan-secret');

    // 空字符串表示清除该项
    store.save({ proxy: '' });
    loaded = store.load();
    assert.equal(loaded.proxy, undefined);
    assert.equal(loaded.openSubtitlesApiKey, 'opensubtitles-key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SettingsSecretStore: 文件损坏时返回空对象而不是崩溃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-settings-secrets-bad-'));
  const filePath = path.join(dir, 'settings-secrets.json');
  fs.writeFileSync(filePath, '{not-json', 'utf8');
  const store = new SettingsSecretStore({ filePath, adapter: fakeStorage });
  try {
    assert.deepEqual(store.load(), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
