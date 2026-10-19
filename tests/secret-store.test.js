const test = require('node:test');
const assert = require('node:assert/strict');

const {
  protectValue,
  revealValue,
  protectSourcePackSecrets,
  revealSourcePackSecrets
} = require('../src/main/utils/secretStore');

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
