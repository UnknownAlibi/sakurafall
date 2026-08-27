const fs = require('fs');
const path = require('path');

const SOURCE_PACK_KIND = 'sakurafall.source-pack';
const THEME_PACK_KIND = 'sakurafall.theme-pack';
const PACK_API_VERSION = 1;
const MAX_PACK_BYTES = 512 * 1024;
const MAX_THEME_PACK_BYTES = 8 * 1024 * 1024;
const MAX_CUSTOM_CSS_BYTES = 128 * 1024;
const MAX_THEME_ASSET_BYTES = 2 * 1024 * 1024;
const THEME_ASSET_SLOTS = new Set([
  'brandMark',
  'mascot',
  'loadingMascot',
  'loadingAnimation',
  'cursorDefault',
  'cursorPointer',
  'emptyState',
  'background'
]);
const SOURCE_HEADER_NAMES = new Set(['referer', 'origin', 'user-agent']);

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

class CustomizationPackService {
  constructor(options = {}) {
    this.cmsApiService = options.cmsApiService;
    this.sourcePluginManager = options.sourcePluginManager;
    this.sharePageResolver = options.sharePageResolver;
    this.mediaLibraryService = options.mediaLibraryService;
    this.builtInThemeDir = '';
    this.userThemeDir = '';
    this.builtInSourceDir = '';
    this.userSourceDir = '';
  }

  setThemePaths({ builtInThemeDir, userThemeDir } = {}) {
    this.builtInThemeDir = builtInThemeDir || '';
    this.userThemeDir = userThemeDir || '';
  }

  setSourcePaths({ builtInSourceDir, userSourceDir } = {}) {
    this.builtInSourceDir = builtInSourceDir || '';
    this.userSourceDir = userSourceDir || '';
    return this.activateSourcePacks();
  }

  parsePack(input, maxBytes = MAX_PACK_BYTES) {
    const text = typeof input === 'string' ? input : JSON.stringify(input || {});
    if (byteLength(text) > maxBytes) throw new Error(`扩展包超过 ${Math.round(maxBytes / 1024)}KB 限制`);

    let pack;
    try {
      pack = JSON.parse(text);
    } catch (error) {
      throw new Error(`扩展包 JSON 无效: ${error.message}`);
    }

    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
      throw new Error('扩展包必须是 JSON 对象');
    }
    if (Number(pack.apiVersion) !== PACK_API_VERSION) {
      throw new Error(`不支持的 apiVersion: ${pack.apiVersion}`);
    }
    return pack;
  }

  normalizeMetadata(raw = {}) {
    const id = String(raw.id || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw new Error('扩展包 id 格式无效');

    const name = String(raw.name || '').trim();
    if (!name) throw new Error('扩展包名称不能为空');

    return {
      id,
      name: name.slice(0, 80),
      version: String(raw.version || '1.0.0').slice(0, 32),
      author: String(raw.author || 'Anonymous').slice(0, 80),
      description: String(raw.description || '').slice(0, 300),
      homepage: this._safeHttpUrl(raw.homepage),
      updateUrl: this._safeHttpUrl(raw.updateUrl),
      license: String(raw.license || '').slice(0, 40),
      minAppVersion: String(raw.minAppVersion || '').slice(0, 32),
      tags: Array.isArray(raw.tags) ? raw.tags.map(tag => String(tag).slice(0, 24)).slice(0, 12) : []
    };
  }

  _safeHttpUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? url.slice(0, 500) : '';
  }

  validateSourcePack(input) {
    const pack = this.parsePack(input, MAX_PACK_BYTES);
    if (pack.kind !== SOURCE_PACK_KIND) throw new Error(`扩展包类型必须是 ${SOURCE_PACK_KIND}`);

    const metadata = this.normalizeMetadata(pack.metadata);
    const cmsSources = Array.isArray(pack.content?.cmsSources) ? pack.content.cmsSources : [];
    const xpathRules = Array.isArray(pack.content?.xpathRules) ? pack.content.xpathRules : [];
    const resolvers = Array.isArray(pack.content?.resolvers) ? pack.content.resolvers : [];
    const mediaLibraries = Array.isArray(pack.content?.mediaLibraries) ? pack.content.mediaLibraries : [];
    if (cmsSources.length + xpathRules.length + resolvers.length + mediaLibraries.length === 0) {
      throw new Error('源包中没有 CMS 源、XPath 规则或分享页解析规则');
    }
    if (cmsSources.length > 100 || xpathRules.length > 100 || resolvers.length > 100 || mediaLibraries.length > 100) {
      throw new Error('单个源包最多包含 100 个同类配置');
    }

    const normalizedCmsSources = cmsSources.map((source, index) => {
      try {
        return this.cmsApiService?._normalizeSourceConfig
          ? this.cmsApiService._normalizeSourceConfig(source)
          : source;
      } catch (error) {
        throw new Error(`CMS 源 #${index + 1} 无效: ${error.message}`);
      }
    });
    const normalizedXpathRules = xpathRules.map((raw, index) => {
      if (!this.sourcePluginManager?.ruleEngine?.validateRule) return raw;
      const result = this.sourcePluginManager.ruleEngine.validateRule(raw);
      if (!result.valid) throw new Error(`XPath 规则 #${index + 1} 无效: ${result.error}`);
      return result.rule;
    });
    const normalizedResolvers = resolvers.map((raw, index) => this._normalizeResolver(raw, index));
    const normalizedMediaLibraries = mediaLibraries.map((raw, index) => {
      try {
        return this.mediaLibraryService?.normalizeLibrary
          ? this.mediaLibraryService.normalizeLibrary(raw)
          : raw;
      } catch (error) {
        throw new Error(`媒体库 #${index + 1} 无效: ${error.message}`);
      }
    });

    return {
      kind: SOURCE_PACK_KIND,
      apiVersion: PACK_API_VERSION,
      metadata,
      content: {
        cmsSources: normalizedCmsSources,
        xpathRules: normalizedXpathRules,
        resolvers: normalizedResolvers,
        mediaLibraries: normalizedMediaLibraries
      }
    };
  }

  _normalizeResolver(raw, index = 0) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`分享页解析规则 #${index + 1} 必须是对象`);
    }
    const id = String(raw.id || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
      throw new Error(`分享页解析规则 #${index + 1} 的 id 无效`);
    }
    const name = String(raw.name || id).trim().slice(0, 80);
    const hosts = [...new Set((Array.isArray(raw.hosts) ? raw.hosts : [])
      .map(value => String(value || '').trim().toLowerCase().replace(/^\*\./, ''))
      .filter(value => /^[a-z0-9.-]+$/i.test(value) && value.includes('.')))]
      .slice(0, 20);
    if (hosts.length === 0) throw new Error(`分享页解析规则 ${id} 没有有效 hosts`);

    const pathPrefixes = [...new Set((Array.isArray(raw.pathPrefixes) ? raw.pathPrefixes : [])
      .map(value => String(value || '').trim())
      .filter(value => value.startsWith('/') && value.length <= 200))]
      .slice(0, 20);
    const normalizeHeaders = (headers) => Object.fromEntries(
      Object.entries(headers && typeof headers === 'object' ? headers : {})
        .filter(([key]) => SOURCE_HEADER_NAMES.has(String(key).toLowerCase()))
        .map(([key, value]) => [key, String(value || '').slice(0, 500)])
    );

    return {
      id,
      name,
      hosts,
      pathPrefixes,
      requestHeaders: normalizeHeaders(raw.requestHeaders),
      playbackHeaders: normalizeHeaders(raw.playbackHeaders)
    };
  }

  importSourcePack(input, options = {}) {
    const pack = this.validateSourcePack(input);
    const overwrite = options.overwrite !== false;
    const shouldInstall = options.install !== false && !!this.userSourceDir;
    if (shouldInstall) {
      fs.mkdirSync(this.userSourceDir, { recursive: true });
      const targetPath = path.join(this.userSourceDir, `${pack.metadata.id}.sourcepack.json`);
      if (!overwrite && fs.existsSync(targetPath)) {
        return { success: false, error: '同 id 的片源包已安装', metadata: pack.metadata, installed: false };
      }
      fs.writeFileSync(targetPath, JSON.stringify(pack, null, 2), 'utf8');
    }

    let activation;
    if (shouldInstall) {
      activation = this.activateSourcePacks();
    } else {
      const cmsResult = pack.content.cmsSources.length && this.cmsApiService?.importSources
        ? this.cmsApiService.importSources(JSON.stringify({ sources: pack.content.cmsSources }), { overwrite })
        : { success: true, added: 0, overwritten: 0, skipped: 0, errors: [] };
      const xpathResult = pack.content.xpathRules.length && this.sourcePluginManager?.importRules
        ? this.sourcePluginManager.importRules(JSON.stringify({ rules: pack.content.xpathRules }), { overwrite })
        : { success: true, added: 0, overwritten: 0, skipped: 0, errors: [] };
      this.sharePageResolver?.setResolvers?.(pack.content.resolvers);
      this.mediaLibraryService?.setLibraries?.(pack.content.mediaLibraries);
      activation = { success: cmsResult.success !== false && xpathResult.success !== false, cms: cmsResult, xpath: xpathResult };
    }

    return {
      success: activation.success !== false,
      metadata: pack.metadata,
      ...activation,
      installed: shouldInstall
    };
  }

  activateSourcePacks() {
    const packs = new Map();
    this._readSourcePackDir(this.builtInSourceDir, true).forEach(pack => packs.set(pack.metadata.id, pack));
    this._readSourcePackDir(this.userSourceDir, false).forEach(pack => packs.set(pack.metadata.id, pack));

    const cmsSources = [];
    const xpathRules = [];
    const resolvers = [];
    const mediaLibraries = [];
    for (const pack of packs.values()) {
      const sourcePackId = pack.metadata.id;
      cmsSources.push(...pack.content.cmsSources.map(source => ({ ...source, sourcePackId })));
      xpathRules.push(...pack.content.xpathRules.map(rule => ({ ...rule, sourcePackId })));
      resolvers.push(...pack.content.resolvers.map(rule => ({ ...rule, sourcePackId })));
      mediaLibraries.push(...pack.content.mediaLibraries.map(library => ({ ...library, sourcePackId })));
    }

    this.cmsApiService?.setPackSources?.(cmsSources);
    this.sourcePluginManager?.setPackRules?.(xpathRules);
    this.sharePageResolver?.setResolvers?.(resolvers);
    this.mediaLibraryService?.setLibraries?.(mediaLibraries);
    return {
      success: true,
      packCount: packs.size,
      cmsCount: cmsSources.length,
      xpathCount: xpathRules.length,
      resolverCount: resolvers.length,
      mediaLibraryCount: mediaLibraries.length
    };
  }

  listSourcePacks() {
    const packs = new Map();
    this._readSourcePackDir(this.builtInSourceDir, true).forEach(pack => packs.set(pack.metadata.id, pack));
    this._readSourcePackDir(this.userSourceDir, false).forEach(pack => packs.set(pack.metadata.id, pack));
    return Array.from(packs.values()).map(pack => ({
      ...pack.metadata,
      builtIn: !!pack.builtIn,
      sourceCount: pack.content.cmsSources.length + pack.content.xpathRules.length + pack.content.resolvers.length + pack.content.mediaLibraries.length,
      cmsCount: pack.content.cmsSources.length,
      xpathCount: pack.content.xpathRules.length,
      resolverCount: pack.content.resolvers.length,
      mediaLibraryCount: pack.content.mediaLibraries.length
    }));
  }

  getSourcePack(id) {
    const target = String(id || '');
    return [...this._readSourcePackDir(this.userSourceDir, false), ...this._readSourcePackDir(this.builtInSourceDir, true)]
      .find(pack => pack.metadata.id === target) || null;
  }

  getSourcePackUpdateTargets() {
    return this.listSourcePacks()
      .filter(pack => pack.updateUrl)
      .map(pack => ({ id: pack.id, name: pack.name, version: pack.version, updateUrl: pack.updateUrl }));
  }

  isNewerVersion(candidate, current) {
    const parse = value => String(value || '0').split(/[.+-]/).slice(0, 4).map(part => Number.parseInt(part, 10) || 0);
    const next = parse(candidate);
    const installed = parse(current);
    for (let index = 0; index < Math.max(next.length, installed.length); index += 1) {
      if ((next[index] || 0) > (installed[index] || 0)) return true;
      if ((next[index] || 0) < (installed[index] || 0)) return false;
    }
    return false;
  }

  removeSourcePack(id) {
    const safeId = String(id || '');
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(safeId)) return { success: false, error: '源包 id 无效' };
    const filePath = path.join(this.userSourceDir, `${safeId}.sourcepack.json`);
    if (!fs.existsSync(filePath)) return { success: false, error: '只能删除用户安装的源包' };
    this.validateSourcePack(fs.readFileSync(filePath, 'utf8'));
    fs.unlinkSync(filePath);
    const activation = this.activateSourcePacks();
    return { success: true, removed: safeId, ...activation };
  }

  exportSourcePack(metadata = {}) {
    const cmsExport = this.cmsApiService.exportSources({ includeBuiltIn: true });
    const xpathExport = this.sourcePluginManager.exportRules();
    const cmsSources = cmsExport.json ? JSON.parse(cmsExport.json).sources || [] : [];
    const xpathRules = xpathExport.json ? JSON.parse(xpathExport.json).rules || [] : [];
    const resolvers = this.sharePageResolver?.exportResolvers?.() || [];
    const mediaLibraries = this.mediaLibraryService?.exportLibraries?.() || [];
    const pack = {
      kind: SOURCE_PACK_KIND,
      apiVersion: PACK_API_VERSION,
      metadata: this.normalizeMetadata({
        id: metadata.id || 'my-source-pack',
        name: metadata.name || '我的片源包',
        version: metadata.version || '1.0.0',
        author: metadata.author || 'SakuraFall User',
        description: metadata.description || '由SAKURAFALL导出的片源配置'
      }),
      content: { cmsSources, xpathRules, resolvers, mediaLibraries }
    };

    return {
      success: true,
      pack,
      json: JSON.stringify(pack, null, 2),
      count: cmsSources.length + xpathRules.length + resolvers.length + mediaLibraries.length
    };
  }

  sanitizeCustomCss(value) {
    let css = String(value || '');
    if (byteLength(css) > MAX_CUSTOM_CSS_BYTES) throw new Error('自定义 CSS 超过 128KB 限制');

    css = css
      .replace(/@import[\s\S]*?;/gi, '')
      .replace(/@font-face\s*\{[\s\S]*?\}/gi, '')
      .replace(/url\s*\([^)]*\)/gi, 'none')
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/-webkit-app-region\s*:[^;}]+;?/gi, '');
    return css;
  }

  validateThemePack(input, options = {}) {
    const pack = this.parsePack(input, MAX_THEME_PACK_BYTES);
    if (pack.kind !== THEME_PACK_KIND) throw new Error(`扩展包类型必须是 ${THEME_PACK_KIND}`);

    const metadata = this.normalizeMetadata(pack.metadata);
    const variables = {};
    for (const [key, value] of Object.entries(pack.content?.variables || {})) {
      if (!/^--[a-z0-9-]{2,64}$/i.test(key)) continue;
      const normalizedValue = String(value).slice(0, 200);
      if (/url\s*\(|javascript\s*:|expression\s*\(/i.test(normalizedValue)) continue;
      variables[key] = normalizedValue;
    }

    const assets = {};
    let totalAssetBytes = 0;
    for (const [slot, value] of Object.entries(pack.content?.assets || {})) {
      if (!THEME_ASSET_SLOTS.has(slot)) continue;
      const asset = String(value || '').trim();
      if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(asset)) continue;
      const size = byteLength(asset);
      if (size > MAX_THEME_ASSET_BYTES) throw new Error(`主题资源 ${slot} 超过 2MB 限制`);
      totalAssetBytes += size;
      assets[slot] = asset;
    }
    if (totalAssetBytes > MAX_THEME_PACK_BYTES - MAX_CUSTOM_CSS_BYTES) throw new Error('主题资源总大小超过限制');

    const assetFiles = {};
    if (options.allowAssetFiles === true) {
      for (const [slot, value] of Object.entries(pack.content?.assetFiles || {})) {
        if (!THEME_ASSET_SLOTS.has(slot)) continue;
        const relativePath = String(value || '').trim().replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..')) continue;
        if (!/^[a-z0-9_./-]+\.(?:png|jpe?g|webp|gif)$/i.test(relativePath)) continue;
        assetFiles[slot] = relativePath;
      }
    }

    const layout = {};
    const allowedLayout = {
      density: ['compact', 'comfortable', 'airy'],
      cardStyle: ['clean', 'manga', 'glass'],
      navigation: ['rail', 'wide'],
      motion: ['reduced', 'balanced', 'expressive']
    };
    for (const [key, values] of Object.entries(allowedLayout)) {
      if (values.includes(pack.content?.layout?.[key])) layout[key] = pack.content.layout[key];
    }

    return {
      kind: THEME_PACK_KIND,
      apiVersion: PACK_API_VERSION,
      metadata,
      content: {
        variables,
        assets,
        assetFiles,
        layout,
        customCss: this.sanitizeCustomCss(pack.content?.customCss || '')
      }
    };
  }

  listThemePacks() {
    const packs = new Map();
    this._readPackDir(this.builtInThemeDir, true).forEach(pack => packs.set(pack.metadata.id, pack));
    this._readPackDir(this.userThemeDir, false).forEach(pack => packs.set(pack.metadata.id, pack));
    return Array.from(packs.values()).map(pack => ({ ...pack.metadata, builtIn: !!pack.builtIn }));
  }

  getThemePack(id) {
    const target = String(id || '');
    return [...this._readPackDir(this.userThemeDir, false), ...this._readPackDir(this.builtInThemeDir, true)]
      .find(pack => pack.metadata.id === target) || null;
  }

  installThemePack(input) {
    const pack = this.validateThemePack(input);
    if (!this.userThemeDir) throw new Error('用户主题目录未初始化');

    fs.mkdirSync(this.userThemeDir, { recursive: true });
    fs.writeFileSync(path.join(this.userThemeDir, `${pack.metadata.id}.json`), JSON.stringify(pack, null, 2), 'utf8');
    return { success: true, metadata: pack.metadata };
  }

  removeThemePack(id) {
    const safeId = String(id || '');
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(safeId)) return { success: false, error: '主题 id 无效' };

    const filePath = path.join(this.userThemeDir, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return { success: false, error: '只能删除用户安装的主题' };
    fs.unlinkSync(filePath);
    return { success: true, removed: safeId };
  }

  _readPackDir(dirPath, builtIn) {
    if (!dirPath || !fs.existsSync(dirPath)) return [];

    const result = [];
    for (const file of fs.readdirSync(dirPath).filter(name => name.endsWith('.json'))) {
      try {
        const packPath = path.join(dirPath, file);
        const pack = this.validateThemePack(fs.readFileSync(packPath, 'utf8'), { allowAssetFiles: builtIn });
        if (builtIn) this._hydrateBuiltInThemeAssets(pack, path.dirname(packPath));
        pack.builtIn = builtIn;
        result.push(pack);
      } catch (error) {
        console.warn(`[CustomizationPack] 忽略无效主题 ${file}:`, error.message);
      }
    }
    return result;
  }

  _hydrateBuiltInThemeAssets(pack, baseDir) {
    const root = path.resolve(baseDir);
    let totalBytes = 0;
    for (const [slot, relativePath] of Object.entries(pack.content.assetFiles || {})) {
      const filePath = path.resolve(root, relativePath);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) continue;
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > MAX_THEME_ASSET_BYTES) continue;
      totalBytes += buffer.length;
      if (totalBytes > MAX_THEME_PACK_BYTES - MAX_CUSTOM_CSS_BYTES) break;
      const extension = path.extname(filePath).toLowerCase();
      const mime = extension === '.png'
        ? 'image/png'
        : extension === '.gif'
          ? 'image/gif'
          : extension === '.webp'
            ? 'image/webp'
            : 'image/jpeg';
      pack.content.assets[slot] = `data:${mime};base64,${buffer.toString('base64')}`;
    }
    delete pack.content.assetFiles;
  }

  _readSourcePackDir(dirPath, builtIn) {
    if (!dirPath || !fs.existsSync(dirPath)) return [];
    const result = [];
    for (const file of fs.readdirSync(dirPath).filter(name => /\.(?:json|sourcepack)$/i.test(name))) {
      try {
        const pack = this.validateSourcePack(fs.readFileSync(path.join(dirPath, file), 'utf8'));
        pack.builtIn = builtIn;
        result.push(pack);
      } catch (error) {
        console.warn(`[CustomizationPack] 忽略无效源包 ${file}:`, error.message);
      }
    }
    return result;
  }
}

module.exports = {
  CustomizationPackService,
  SOURCE_PACK_KIND,
  THEME_PACK_KIND,
  PACK_API_VERSION,
  MAX_PACK_BYTES,
  MAX_THEME_PACK_BYTES,
  MAX_CUSTOM_CSS_BYTES
};
