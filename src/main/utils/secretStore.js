/**
 * 凭据加密存储（Electron safeStorage）。
 *
 * 背景：源包里的媒体库凭据（password / bearerToken / apiKey）此前是明文写进
 * userData 下的 *.sourcepack.json，只有导出时才脱敏替换。这里在落盘前用
 * safeStorage 加密、读取时解密，避免明文凭证长期躺在磁盘上。
 *
 * 纯 Node 环境（单测/无 electron）拿不到 safeStorage，此时 protect/reveal 均为
 * 空操作，读写行为与改造前完全一致——旧明文配置也能继续读。
 */

const PREFIX = 'safe:v1:';
const SECRET_FIELDS = ['password', 'bearerToken', 'apiKey'];
// ${ENV:XXX} 本身就是引用而非明文，保持原样（导出时也依赖它不被改写）
const ENV_REFERENCE = /^\$\{ENV:[A-Z0-9_]+\}$/i;

let resolved = false;
let storage = null;

/**
 * 取 Electron safeStorage；不可用（纯 node、系统无密钥后端）时返回 null。
 * 首次解析后缓存，避免每次读写都 require。
 */
function electronSafeStorage() {
  if (resolved) return storage;
  resolved = true;
  try {
    // 纯 node 下 require('electron') 得到的是可执行文件路径字符串，safeStorage 为 undefined
    const electron = require('electron');
    const candidate = electron && electron.safeStorage;
    if (candidate && typeof candidate.isEncryptionAvailable === 'function' && candidate.isEncryptionAvailable()) {
      storage = candidate;
    }
  } catch (_error) { /* 无 electron：退化为明文，与改造前一致 */ }
  return storage;
}

function protectValue(value, adapter) {
  const text = String(value || '');
  if (!text || text.startsWith(PREFIX) || ENV_REFERENCE.test(text)) return text;
  if (!adapter) return text;
  try {
    return PREFIX + adapter.encryptString(text).toString('base64');
  } catch (_error) {
    return text;
  }
}

function revealValue(value, adapter) {
  const text = String(value || '');
  if (!text.startsWith(PREFIX)) return text;
  // 解不开（换机/密钥后端不可用）时原样保留，宁可不解密也不丢数据
  if (!adapter) return text;
  try {
    return adapter.decryptString(Buffer.from(text.slice(PREFIX.length), 'base64'));
  } catch (_error) {
    return text;
  }
}

function mapPackLibraries(pack, transform, adapter) {
  const libraries = pack && pack.content && pack.content.mediaLibraries;
  if (!Array.isArray(libraries)) return pack;
  return {
    ...pack,
    content: {
      ...pack.content,
      mediaLibraries: libraries.map(library => {
        if (!library || typeof library !== 'object') return library;
        const next = { ...library };
        for (const field of SECRET_FIELDS) {
          if (next[field] !== undefined) next[field] = transform(next[field], adapter);
        }
        return next;
      })
    }
  };
}

/**
 * 落盘前加密源包内媒体库凭据（返回新对象，不改入参）。
 * @param {object} pack
 * @param {object|null} [adapter] 仅测试注入，缺省用 Electron safeStorage
 */
function protectSourcePackSecrets(pack, adapter = electronSafeStorage()) {
  return mapPackLibraries(pack, protectValue, adapter);
}

/**
 * 读取后解密源包内媒体库凭据；入参可以是 JSON 文本或已解析对象。
 * @param {string|object} input
 * @param {object|null} [adapter]
 */
function revealSourcePackSecrets(input, adapter = electronSafeStorage()) {
  let pack = input;
  if (typeof pack === 'string') {
    try {
      pack = JSON.parse(pack);
    } catch (_error) {
      return input;
    }
  }
  return mapPackLibraries(pack, revealValue, adapter);
}

module.exports = {
  protectValue,
  revealValue,
  protectSourcePackSecrets,
  revealSourcePackSecrets
};
