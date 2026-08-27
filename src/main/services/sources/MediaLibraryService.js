const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const HttpClient = require('../../utils/HttpClient');

const MEDIA_TYPES = new Set(['local', 'webdav', 'jellyfin', 'emby']);
const DEFAULT_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.webm', '.mov', '.avi', '.ts', '.m2ts'];
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'poster.jpg', 'poster.jpeg', 'poster.png', 'folder.jpg'];

function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function cleanEpisodeTitle(fileName) {
  return path.basename(String(fileName || ''), path.extname(String(fileName || '')))
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSeriesTitle(fileName) {
  return cleanEpisodeTitle(fileName)
    .replace(/(?:S\d{1,2})?E\d{1,4}.*$/i, '')
    .replace(/(?:第\s*)?\d{1,4}\s*(?:集|话).*$/i, '')
    .replace(/[-\s]+$/, '') || cleanEpisodeTitle(fileName);
}

function resolveSecret(value) {
  const text = String(value || '').trim();
  const match = text.match(/^\$\{ENV:([A-Z0-9_]+)\}$/i);
  return match ? String(process.env[match[1]] || '') : text;
}

function encodeBasic(username, password) {
  if (!username && !password) return '';
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

class MediaLibraryService {
  constructor(options = {}) {
    this.http = options.httpClient || new HttpClient({ timeout: 15000, maxResponseBytes: 20 * 1024 * 1024 });
    this.libraries = [];
    this.indexCache = new Map();
    this.mediaTokens = new Map();
    this.cacheTtl = 2 * 60 * 1000;
  }

  normalizeLibrary(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('媒体库配置必须是对象');
    const id = String(raw.id || '').trim();
    const name = String(raw.name || '').trim();
    const type = String(raw.type || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) throw new Error('媒体库 id 格式无效');
    if (!name) throw new Error('媒体库名称不能为空');
    if (!MEDIA_TYPES.has(type)) throw new Error(`不支持的媒体库类型: ${type}`);

    const library = {
      id,
      name: name.slice(0, 80),
      type,
      enabled: raw.enabled !== false,
      preference: Math.max(-20, Math.min(20, Number(raw.preference) || 0)),
      sourcePackId: String(raw.sourcePackId || '').slice(0, 64)
    };
    if (type === 'local') {
      const roots = Array.isArray(raw.roots) ? raw.roots : [raw.root].filter(Boolean);
      library.roots = [...new Set(roots.map(root => path.resolve(String(root || '').trim())).filter(Boolean))].slice(0, 12);
      if (library.roots.length === 0) throw new Error(`本地媒体库 ${id} 至少需要一个目录`);
      library.maxDepth = Math.max(1, Math.min(12, Number(raw.maxDepth) || 6));
      library.maxFiles = Math.max(100, Math.min(50000, Number(raw.maxFiles) || 20000));
      library.extensions = [...new Set((raw.extensions || DEFAULT_EXTENSIONS).map(ext => {
        const value = String(ext || '').toLowerCase();
        return value.startsWith('.') ? value : `.${value}`;
      }))].filter(ext => /^\.[a-z0-9]{2,5}$/.test(ext)).slice(0, 30);
    } else {
      const baseUrl = String(raw.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`媒体库 ${id} 的 baseUrl 无效`);
      library.baseUrl = baseUrl;
      library.username = String(raw.username || '').slice(0, 120);
      library.password = String(raw.password || raw.passwordRef || '').slice(0, 500);
      library.bearerToken = String(raw.bearerToken || raw.tokenRef || '').slice(0, 500);
      library.apiKey = String(raw.apiKey || raw.apiKeyRef || '').slice(0, 500);
      library.userId = String(raw.userId || '').slice(0, 120);
      library.libraryId = String(raw.libraryId || '').slice(0, 120);
      library.rootPath = String(raw.rootPath || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
      library.depth = Math.max(1, Math.min(4, Number(raw.depth) || 3));
    }
    return library;
  }

  setLibraries(libraries = []) {
    const normalized = [];
    for (const raw of Array.isArray(libraries) ? libraries : []) {
      normalized.push(this.normalizeLibrary(raw));
    }
    this.libraries = normalized;
    this.indexCache.clear();
    this.mediaTokens.clear();
    return this.listLibraries();
  }

  listLibraries() {
    return this.libraries.map(library => ({
      id: library.id,
      name: library.name,
      type: library.type,
      enabled: library.enabled,
      preference: library.preference,
      sourcePackId: library.sourcePackId,
      roots: library.type === 'local' ? library.roots.slice() : undefined,
      baseUrl: library.type === 'local' ? undefined : library.baseUrl,
      userId: library.userId || '',
      libraryId: library.libraryId || '',
      rootPath: library.rootPath || '',
      credentialsConfigured: !!(resolveSecret(library.apiKey) || resolveSecret(library.bearerToken) || resolveSecret(library.password))
    }));
  }

  exportLibraries() {
    const shareableSecret = value => /^\$\{ENV:[A-Z0-9_]+\}$/i.test(String(value || '')) ? value : '';
    return this.libraries.map(library => {
      const exported = { ...library };
      if (library.type !== 'local') {
        exported.password = shareableSecret(library.password);
        exported.bearerToken = shareableSecret(library.bearerToken);
        exported.apiKey = shareableSecret(library.apiKey);
      }
      return exported;
    });
  }

  getLibrary(id) {
    return this.libraries.find(item => item.id === String(id || '')) || null;
  }

  getPlaybackHeaders(id) {
    const library = this.getLibrary(id);
    if (!library || library.type === 'local') return {};
    return this._authorizationHeaders(library);
  }

  resolveMediaPath(requestUrl) {
    try {
      const url = new URL(requestUrl);
      if (url.protocol !== 'sakurafall-media:' || url.hostname !== 'asset') return '';
      const token = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const entry = this.mediaTokens.get(token);
      if (!entry || !fs.existsSync(entry.filePath)) return '';
      return entry.filePath;
    } catch (_) {
      return '';
    }
  }

  async search(id, keyword, options = {}) {
    const library = this._requireLibrary(id);
    const query = String(keyword || '').trim().toLowerCase();
    const index = await this._getIndex(library, options);
    const data = index.filter(item => !query || String(item.name || '').toLowerCase().includes(query));
    return { success: true, data: data.slice(0, Math.max(1, Number(options.limit) || 50)), total: data.length, page: 1, totalPages: 1 };
  }

  async getCatalog(id, options = {}) {
    const library = this._requireLibrary(id);
    const index = await this._getIndex(library, options);
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.max(10, Math.min(100, Number(options.pageSize) || 40));
    return {
      success: true,
      data: index.slice((page - 1) * pageSize, page * pageSize),
      total: index.length,
      page,
      totalPages: Math.max(1, Math.ceil(index.length / pageSize))
    };
  }

  async getDetail(id, reference = {}) {
    const library = this._requireLibrary(id);
    if (reference?.episodes && Object.keys(reference.episodes).length > 0) return reference;
    if (library.type === 'jellyfin' || library.type === 'emby') {
      return this._getMediaServerDetail(library, reference);
    }
    const index = await this._getIndex(library);
    return index.find(item => String(item.id) === String(reference?.id || reference)) || reference;
  }

  async test(id) {
    const library = this._requireLibrary(id);
    const startedAt = Date.now();
    if (library.type === 'local') {
      const accessible = library.roots.filter(root => fs.existsSync(root) && fs.statSync(root).isDirectory());
      if (accessible.length === 0) throw new Error('配置的本地目录均不可访问');
      return { success: true, message: `可访问 ${accessible.length}/${library.roots.length} 个目录`, elapsedMs: Date.now() - startedAt };
    }
    if (library.type === 'webdav') {
      await this._fetchWebDav(library, '0');
    } else {
      await this._fetchJson(`${library.baseUrl}/System/Info/Public`, { headers: this._authorizationHeaders(library) });
    }
    return { success: true, message: '连接成功', elapsedMs: Date.now() - startedAt };
  }

  async resolveEpisode(id, episode = {}) {
    const library = this._requireLibrary(id);
    const url = episode.realUrl || episode.real_video_url || episode.url || episode.play_url || '';
    return { url, providerId: `media:${library.id}`, headers: this.getPlaybackHeaders(library.id) };
  }

  _requireLibrary(id) {
    const library = this.getLibrary(id);
    if (!library) throw new Error(`媒体库不存在: ${id}`);
    if (!library.enabled) throw new Error(`媒体库已停用: ${library.name}`);
    return library;
  }

  async _getIndex(library, options = {}) {
    const cached = this.indexCache.get(library.id);
    if (!options.refresh && cached && Date.now() - cached.createdAt < this.cacheTtl) return cached.data;
    if (cached?.promise) return cached.promise;
    const promise = (library.type === 'local'
      ? this._scanLocalLibrary(library)
      : library.type === 'webdav'
        ? this._scanWebDavLibrary(library)
        : this._scanMediaServerLibrary(library))
      .then(data => {
        this.indexCache.set(library.id, { createdAt: Date.now(), data });
        return data;
      })
      .catch(error => {
        this.indexCache.delete(library.id);
        throw error;
      });
    this.indexCache.set(library.id, { createdAt: Date.now(), data: [], promise });
    return promise;
  }

  _mediaUrl(libraryId, filePath) {
    const normalized = path.resolve(filePath);
    const token = crypto.createHash('sha256').update(`${libraryId}\0${normalized}`).digest('hex').slice(0, 32);
    this.mediaTokens.set(token, { libraryId, filePath: normalized });
    return `sakurafall-media://asset/${token}`;
  }

  async _scanLocalLibrary(library) {
    const groups = new Map();
    let visited = 0;
    for (const root of library.roots) {
      if (!fs.existsSync(root)) continue;
      const queue = [{ dir: root, depth: 0 }];
      while (queue.length > 0 && visited < library.maxFiles) {
        const current = queue.shift();
        let entries;
        try { entries = await fs.promises.readdir(current.dir, { withFileTypes: true }); } catch (_) { continue; }
        let coverPath = '';
        for (const entry of entries) {
          if (entry.isFile() && COVER_NAMES.includes(entry.name.toLowerCase())) coverPath = path.join(current.dir, entry.name);
        }
        for (const entry of entries) {
          if (entry.isDirectory() && current.depth < library.maxDepth) {
            queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile() || !library.extensions.includes(path.extname(entry.name).toLowerCase())) continue;
          visited += 1;
          const filePath = path.join(current.dir, entry.name);
          const relativeDir = path.relative(root, current.dir);
          const groupName = relativeDir && relativeDir !== '.' ? path.basename(current.dir) : cleanSeriesTitle(entry.name);
          const groupKey = `${root}\0${relativeDir || groupName}`;
          if (!groups.has(groupKey)) {
            groups.set(groupKey, {
              id: crypto.createHash('sha1').update(`${library.id}\0${groupKey}`).digest('hex').slice(0, 20),
              name: groupName,
              cover: coverPath ? this._mediaUrl(library.id, coverPath) : '',
              summary: current.dir,
              episodes: { '本地媒体': [] },
              source: library.id,
              sourceId: library.id,
              providerId: `media:${library.id}`,
              sourceType: 'media',
              sourceName: library.name
            });
          }
          groups.get(groupKey).episodes['本地媒体'].push({
            id: this._mediaUrl(library.id, filePath),
            title: cleanEpisodeTitle(entry.name),
            url: this._mediaUrl(library.id, filePath),
            sourceId: library.id,
            lineName: '本地媒体',
            fileName: entry.name
          });
          if (visited % 250 === 0) await new Promise(resolve => setImmediate(resolve));
        }
      }
    }
    return Array.from(groups.values()).map(item => {
      item.episodes['本地媒体'].sort((a, b) => naturalCompare(a.title, b.title));
      item.episode_count = item.episodes['本地媒体'].length;
      return item;
    }).sort((a, b) => naturalCompare(a.name, b.name));
  }

  _authorizationHeaders(library) {
    const bearer = resolveSecret(library.bearerToken);
    const apiKey = resolveSecret(library.apiKey);
    if (bearer) return { Authorization: `Bearer ${bearer}` };
    if (apiKey && (library.type === 'jellyfin' || library.type === 'emby')) return { 'X-Emby-Token': apiKey };
    const basic = encodeBasic(library.username, resolveSecret(library.password));
    return basic ? { Authorization: basic } : {};
  }

  async _fetchWebDav(library, depth = String(library.depth)) {
    const targetUrl = library.rootPath
      ? new URL(`${library.rootPath}/`, `${library.baseUrl}/`).toString()
      : `${library.baseUrl}/`;
    return this.http.fetch(targetUrl, {
      method: 'PROPFIND',
      headers: {
        ...this._authorizationHeaders(library),
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontenttype/><d:resourcetype/></d:prop></d:propfind>',
      noDedupe: true
    });
  }

  _xmlText(node, localName) {
    const all = node?.getElementsByTagName?.('*') || [];
    for (let index = 0; index < all.length; index += 1) {
      const item = all[index];
      if (String(item.localName || item.nodeName).replace(/^.*:/, '').toLowerCase() === localName.toLowerCase()) {
        return String(item.textContent || '').trim();
      }
    }
    return '';
  }

  async _scanWebDavLibrary(library) {
    const xml = await this._fetchWebDav(library);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const responses = Array.from(doc.getElementsByTagName('*')).filter(node => (
      String(node.localName || node.nodeName).replace(/^.*:/, '').toLowerCase() === 'response'
    ));
    const groups = new Map();
    for (const response of responses) {
      const href = this._xmlText(response, 'href');
      if (!href) continue;
      let url;
      try { url = new URL(href, `${library.baseUrl}/`).toString(); } catch (_) { continue; }
      const fileName = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      const extension = path.extname(fileName).toLowerCase();
      if (!DEFAULT_EXTENSIONS.includes(extension)) continue;
      const parentUrl = new URL('.', url).toString();
      const parentName = decodeURIComponent(new URL(parentUrl).pathname.split('/').filter(Boolean).pop() || cleanSeriesTitle(fileName));
      if (!groups.has(parentUrl)) {
        groups.set(parentUrl, {
          id: crypto.createHash('sha1').update(`${library.id}\0${parentUrl}`).digest('hex').slice(0, 20),
          name: parentName,
          cover: '',
          episodes: { WebDAV: [] },
          source: library.id,
          sourceId: library.id,
          providerId: `media:${library.id}`,
          sourceType: 'media',
          sourceName: library.name
        });
      }
      groups.get(parentUrl).episodes.WebDAV.push({
        id: url,
        title: cleanEpisodeTitle(fileName),
        url,
        sourceId: library.id,
        lineName: 'WebDAV'
      });
    }
    return Array.from(groups.values()).map(item => {
      item.episodes.WebDAV.sort((a, b) => naturalCompare(a.title, b.title));
      item.episode_count = item.episodes.WebDAV.length;
      return item;
    }).sort((a, b) => naturalCompare(a.name, b.name));
  }

  async _fetchJson(url, options = {}) {
    const text = await this.http.fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    return JSON.parse(text);
  }

  _serverUrl(library, pathname, params = {}) {
    const url = new URL(pathname, `${library.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value != null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  _mapServerSeries(library, item) {
    const apiKey = resolveSecret(library.apiKey);
    return {
      id: String(item.Id || item.id || ''),
      name: item.Name || item.name || '',
      cover: this._serverUrl(library, `Items/${item.Id}/Images/Primary`, { maxWidth: 480, quality: 85, api_key: apiKey }),
      summary: item.Overview || '',
      year: item.ProductionYear || 0,
      score: item.CommunityRating || 0,
      episodes: {},
      source: library.id,
      sourceId: library.id,
      providerId: `media:${library.id}`,
      sourceType: 'media',
      sourceName: library.name
    };
  }

  async _scanMediaServerLibrary(library) {
    const data = await this._fetchJson(this._serverUrl(library, `Users/${library.userId}/Items`, {
      ParentId: library.libraryId,
      IncludeItemTypes: 'Series',
      Recursive: true,
      Fields: 'Overview,ProductionYear,CommunityRating',
      Limit: 10000
    }), { headers: this._authorizationHeaders(library) });
    return (data.Items || data.items || []).map(item => this._mapServerSeries(library, item));
  }

  async _getMediaServerDetail(library, reference = {}) {
    const seriesId = String(reference.id || reference.Id || '');
    if (!seriesId) return reference;
    const data = await this._fetchJson(this._serverUrl(library, `Shows/${seriesId}/Episodes`, {
      UserId: library.userId,
      Fields: 'Overview,IndexNumber,ParentIndexNumber,MediaSources',
      Limit: 10000
    }), { headers: this._authorizationHeaders(library) });
    const apiKey = resolveSecret(library.apiKey);
    const episodes = (data.Items || data.items || []).map((item, index) => ({
      id: String(item.Id || ''),
      title: item.Name || `第${item.IndexNumber || index + 1}集`,
      index: Number(item.IndexNumber) > 0 ? Number(item.IndexNumber) - 1 : index,
      url: this._serverUrl(library, `Videos/${item.Id}/stream`, { Static: true, api_key: apiKey }),
      sourceId: library.id,
      lineName: library.type === 'jellyfin' ? 'Jellyfin' : 'Emby',
      quality: item.MediaSources?.[0] ? {
        bitrate: item.MediaSources[0].Bitrate || 0,
        width: item.MediaSources[0].Width || 0,
        height: item.MediaSources[0].Height || 0
      } : null
    }));
    return {
      ...reference,
      episodes: { [library.type === 'jellyfin' ? 'Jellyfin' : 'Emby']: episodes },
      episode_count: episodes.length
    };
  }
}

module.exports = { MediaLibraryService, MEDIA_TYPES, DEFAULT_EXTENSIONS, resolveSecret };
