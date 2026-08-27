// 通用苹果 CMS API 服务
// 适配所有苹果 CMS v10 标准接口的资源站
// 接口格式: /api.php/provide/vod/?ac=list|detail&pg=&t=&wd=&ids=

const fs = require('fs');
const path = require('path');
const HttpClient = require('../utils/HttpClient');
// 抽离的子模块（保持门面 API 完全兼容）
const EpisodeParser = require('./cms/EpisodeParser');
const TaskScope = require('./cms/TaskScope');
const SourceHealthTracker = require('./cms/SourceHealthTracker');
const { scoreTitleMatch } = require('./cms/TitleMatcher');

function safeLog(...args) {
  try { console.log(...args); } catch (e) { /* EPIPE ignored */ }
}
function safeError(...args) {
  try { console.error(...args); } catch (e) { /* EPIPE ignored */ }
}

// 尝试获取 Electron userData 路径；非 Electron 环境（如单元测试）使用项目根目录
function getUserDataPath() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      return app.getPath('userData');
    }
  } catch (e) {
    // 不是 Electron 环境
  }
  return path.join(__dirname, '..', '..', '..');
}

class CmsApiService {
  constructor() {
    this.sources = [];
    this.packSources = [];
    this.currentSourceId = null;
    this.timeout = 15000;
    this.db = null; // AnimeDatabase 实例，由外部注入以启用缓存
    // 缓存 TTL（毫秒）
    this.LIST_CACHE_TTL = 5 * 60 * 1000;   // 列表 5 分钟
    this.DETAIL_CACHE_TTL = 30 * 60 * 1000; // 详情 30 分钟
    this.SEARCH_CACHE_TTL = 10 * 60 * 1000; // 搜索 10 分钟，供列表集数补全与详情复用
    this.SOURCE_COOLDOWN_TTL = 10 * 60 * 1000; // 源搜索失败后临时降权 10 分钟
    this.UNSUPPORTED_SEARCH_TTL = 24 * 60 * 60 * 1000; // 明确不支持搜索时降权 24 小时
    this.QUALITY_PROBE_TIMEOUT = 5000;
    this.SEARCH_CONCURRENCY = 3;
    this.QUALITY_PROBE_CONCURRENCY = 3;
    // 抽离的子模块实例（门面委托）
    this._healthTracker = new SourceHealthTracker();
    this._taskScope = new TaskScope();
    this._parser = EpisodeParser;
    // 兼容旧字段引用（部分内部方法直接访问 this.sourceHealth）
    this.sourceHealth = this._healthTracker.sourceHealth;
    this.healthStorePath = null;
    this.healthSaveTimer = null;
    this.SOURCE_HEALTH_STORE_VERSION = 1;
    this.scopedTasks = this._taskScope.scopedTasks;
    // 公共 HTTP 客户端，CMS 接口默认接收 JSON
    this.http = new HttpClient({
      timeout: this.timeout,
      headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' }
    });
    this._loadSources();
  }

  // 注入数据库实例以启用接口缓存
  setDatabase(db) {
    this.db = db;
  }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, parseInt(timeout, 10) || 15000);
    this.http.setTimeout(this.timeout);
  }

  // 设置代理（空字符串表示禁用代理，直连）
  setProxy(proxyUrl) {
    this.http.setProxy(proxyUrl);
  }

  setHealthStorePath(filePath) {
    this.healthStorePath = filePath || null;
    this._healthTracker.setHealthStorePath(filePath);
    // 保持兼容引用
    this.sourceHealth = this._healthTracker.sourceHealth;
  }

  _normalizeHealthRecord(record = {}) {
    const number = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const count = (value) => Math.floor(number(value));

    return {
      successCount: count(record.successCount),
      failureCount: count(record.failureCount),
      playbackSuccessCount: count(record.playbackSuccessCount),
      playbackFailureCount: count(record.playbackFailureCount),
      averageLatency: number(record.averageLatency),
      averageQualityHeight: number(record.averageQualityHeight),
      qualitySampleCount: count(record.qualitySampleCount),
      lastSuccessAt: number(record.lastSuccessAt),
      lastFailureAt: number(record.lastFailureAt),
      lastPlaybackFailureAt: number(record.lastPlaybackFailureAt),
      cooldownUntil: number(record.cooldownUntil),
      reason: typeof record.reason === 'string' ? record.reason.slice(0, 240) : ''
    };
  }

  _loadSourceHealth() {
    if (!this.healthStorePath || !fs.existsSync(this.healthStorePath)) return false;

    try {
      const data = JSON.parse(fs.readFileSync(this.healthStorePath, 'utf8'));
      const sourceRecords = data?.sources && typeof data.sources === 'object'
        ? data.sources
        : data;
      const entries = Array.isArray(sourceRecords)
        ? sourceRecords.map(item => Array.isArray(item)
          ? item
          : [item?.sourceId || item?.id, item])
        : Object.entries(sourceRecords || {});

      for (const [sourceId, record] of entries) {
        if (!sourceId || !record || typeof record !== 'object') continue;
        this.sourceHealth.set(String(sourceId), this._normalizeHealthRecord(record));
      }
      return true;
    } catch (e) {
      safeError('[CmsApi] 读取源健康状态失败:', e.message);
      return false;
    }
  }

  _saveSourceHealth() {
    if (!this.healthStorePath) return false;

    try {
      const sources = {};
      for (const [sourceId, record] of this.sourceHealth.entries()) {
        if (!sourceId) continue;
        sources[String(sourceId)] = this._normalizeHealthRecord(record);
      }

      fs.mkdirSync(path.dirname(this.healthStorePath), { recursive: true });
      fs.writeFileSync(this.healthStorePath, JSON.stringify({
        version: this.SOURCE_HEALTH_STORE_VERSION,
        updatedAt: Date.now(),
        sources
      }, null, 2), 'utf8');
      return true;
    } catch (e) {
      safeError('[CmsApi] 保存源健康状态失败:', e.message);
      return false;
    }
  }

  _scheduleSourceHealthSave() {
    if (!this.healthStorePath) return;
    if (this.healthSaveTimer) clearTimeout(this.healthSaveTimer);

    this.healthSaveTimer = setTimeout(() => {
      this.healthSaveTimer = null;
      this._saveSourceHealth();
    }, 300);

    if (typeof this.healthSaveTimer.unref === 'function') {
      this.healthSaveTimer.unref();
    }
  }

  flushSourceHealth() {
    return this._healthTracker.flushSourceHealth();
  }

  clearSourceHealth({ persist = true } = {}) {
    const result = this._healthTracker.clearSourceHealth({ persist });
    this.sourceHealth = this._healthTracker.sourceHealth;
    return result;
  }

  _abortError(message = 'Task aborted') {
    return this._taskScope.abortError(message);
  }

  _isAbortError(error) {
    return this._taskScope.isAbortError(error);
  }

  _throwIfAborted(signal) {
    return this._taskScope.throwIfAborted(signal);
  }

  _startScopedTask(scope) {
    return this._taskScope.startScopedTask(scope);
  }

  _finishScopedTask(task) {
    return this._taskScope.finishScopedTask(task);
  }

  async _mapWithConcurrency(items, limit, mapper, signal) {
    return this._taskScope.mapWithConcurrency(items, limit, mapper, signal);
  }

  // 生成列表缓存键
  _listCacheKey(sourceId, categoryId, page) {
    return `list:${sourceId}:${categoryId || 'all'}:${page}`;
  }

  // 生成详情缓存键
  _detailCacheKey(sourceId, id) {
    return `detail:${sourceId}:${id}`;
  }

  _searchCacheKey(sourceId, keyword, page) {
    const normalized = String(keyword || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    return `search:${sourceId}:${page}:${normalized}`;
  }

  // 安全读取缓存，失败一律返回 null（不影响主流程）
  _readCache(key) {
    if (!this.db) return null;
    try {
      return this.db.getCache(key);
    } catch (e) {
      safeError('[CmsApi] 读取缓存失败:', e.message);
      return null;
    }
  }

  // 安全写入缓存，失败仅记日志
  _writeCache(key, sourceId, kind, content, ttl) {
    if (!this.db) return;
    try {
      this.db.setCache(key, sourceId, kind, content, ttl);
    } catch (e) {
      safeError('[CmsApi] 写入缓存失败:', e.message);
    }
  }

  // 获取用户自定义配置文件路径
  _getUserConfigPath() {
    return path.join(getUserDataPath(), 'sources.json');
  }

  // 读取并验证单个配置文件
  _readConfigFile(configPath) {
    if (!fs.existsSync(configPath)) return null;
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(text);
      const sources = Array.isArray(config.sources)
        ? config.sources
        : config.content?.cmsSources;
      if (Array.isArray(sources)) return sources.filter(s => s.id && s.name && s.api);
    } catch (e) {
      safeError('[CmsApi] 读取源配置失败:', configPath, e.message);
    }
    return null;
  }

  // 合并已激活片源包与用户手动配置。核心服务本身不读取任何内置站点文件。
  _loadSources() {
    const userSources = this._readConfigFile(this._getUserConfigPath()) || [];

    const sourceMap = new Map();
    for (const source of this.packSources) {
      sourceMap.set(source.id, { ...source, isCustom: false });
    }
    for (const source of userSources) {
      sourceMap.set(source.id, { ...source, isCustom: true });
    }

    this.sources = Array.from(sourceMap.values()).map(s => ({ ...s, available: null }));
    this.currentSourceId = this.sources[0]?.id || null;
  }

  setPackSources(sources = []) {
    this.packSources = (Array.isArray(sources) ? sources : []).map(source => (
      this._normalizeSourceConfig(source)
    ));
    return this.reloadSources();
  }

  // 重新加载源配置（用于设置页修改后刷新）
  reloadSources() {
    const previousId = this.currentSourceId;
    this._loadSources();
    // 尽量保持当前选中的源；如果已失效，则回退到第一个可用源
    const stillExists = this.sources.some(s => s.id === previousId);
    if (stillExists) {
      this.currentSourceId = previousId;
    } else if (this.sources.length > 0) {
      this.currentSourceId = this.sources[0].id;
    }
    return this.getSourceList();
  }

  // 校验单个源配置字段，返回归一化后的配置或抛错
  _normalizeSourceConfig(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('源配置必须是对象');
    }
    const id = String(raw.id || '').trim();
    const name = String(raw.name || '').trim();
    const api = String(raw.api || '').trim();
    if (!id) throw new Error('源 id 不能为空');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error('源 id 只能包含字母、数字、下划线和短横线');
    }
    if (!name) throw new Error('源名称不能为空');
    if (!api) throw new Error('源 API 地址不能为空');
    if (!/^https?:\/\//i.test(api)) {
      throw new Error('源 API 地址必须以 http:// 或 https:// 开头');
    }

    const normalized = { id, name, api };
    if (Array.isArray(raw.categories)) {
      normalized.categories = raw.categories
        .map(cat => {
          if (!cat || typeof cat !== 'object') return null;
          const catId = String(cat.id ?? '').trim();
          const catName = String(cat.name ?? '').trim();
          if (!catId || !catName) return null;
          return { id: catId, name: catName };
        })
        .filter(Boolean);
    }
    if (raw.defaultCategory != null) {
      normalized.defaultCategory = String(raw.defaultCategory);
    }
    if (raw.resolverId != null) normalized.resolverId = String(raw.resolverId).trim().slice(0, 64);
    if (raw.sourcePackId != null) normalized.sourcePackId = String(raw.sourcePackId).trim().slice(0, 64);
    if (Array.isArray(raw.roles)) {
      normalized.roles = [...new Set(raw.roles.map(role => String(role || '').trim()).filter(Boolean))].slice(0, 12);
    }
    if (raw.preference != null) {
      normalized.preference = Math.max(-20, Math.min(20, Number(raw.preference) || 0));
    }
    const normalizeHeaders = (headers) => Object.fromEntries(
      Object.entries(headers && typeof headers === 'object' ? headers : {})
        .filter(([key]) => ['referer', 'origin', 'user-agent'].includes(String(key).toLowerCase()))
        .map(([key, value]) => [key, String(value || '').slice(0, 500)])
    );
    normalized.requestHeaders = normalizeHeaders(raw.requestHeaders);
    normalized.playbackHeaders = normalizeHeaders(raw.playbackHeaders);
    return normalized;
  }

  // 读取用户配置文件的源列表（不合并默认源）
  _readUserSources() {
    const userPath = this._getUserConfigPath();
    if (!fs.existsSync(userPath)) return [];
    try {
      const text = fs.readFileSync(userPath, 'utf8');
      const config = JSON.parse(text);
      if (Array.isArray(config.sources)) {
        return config.sources.filter(s => s && s.id && s.name && s.api);
      }
    } catch (e) {
      safeError('[CmsApi] 读取用户源配置失败:', e.message);
    }
    return [];
  }

  // 将用户源列表写回 userData/sources.json
  _writeUserSources(userSources) {
    const userPath = this._getUserConfigPath();
    try {
      fs.mkdirSync(path.dirname(userPath), { recursive: true });
      const payload = {
        version: 1,
        note: 'SAKURAFALL用户自定义 CMS 源配置。用户源可覆盖默认源（id 相同时）。修改后自动生效。',
        sources: userSources
      };
      fs.writeFileSync(userPath, JSON.stringify(payload, null, 2), 'utf8');
      return true;
    } catch (e) {
      safeError('[CmsApi] 写入用户源配置失败:', e.message);
      return false;
    }
  }

  // 添加数据源（重复 id 视为覆盖）
  // 返回 { success, source?, error? }
  addSource(sourceConfig) {
    let normalized;
    try {
      normalized = this._normalizeSourceConfig(sourceConfig);
    } catch (e) {
      return { success: false, error: e.message };
    }

    const userSources = this._readUserSources();
    const idx = userSources.findIndex(s => s.id === normalized.id);
    const overwritten = idx !== -1;
    if (overwritten) {
      userSources[idx] = normalized;
    } else {
      userSources.push(normalized);
    }

    if (!this._writeUserSources(userSources)) {
      return { success: false, error: '写入用户配置文件失败' };
    }

    // 同步内存中的 sources
    const memIdx = this.sources.findIndex(s => s.id === normalized.id);
    const memSource = { ...normalized, available: null };
    if (memIdx !== -1) {
      this.sources[memIdx] = memSource;
    } else {
      this.sources.push(memSource);
    }

    safeLog(`[CmsApi] ${overwritten ? '覆盖' : '新增'}数据源: ${normalized.name} (${normalized.id})`);
    return { success: true, source: normalized, overwritten };
  }

  // 更新指定源（不允许修改 id 本身）
  // 返回 { success, source?, error? }
  updateSource(sourceId, config) {
    const sid = String(sourceId || '').trim();
    if (!sid) return { success: false, error: '源 id 不能为空' };

    let normalized;
    try {
      normalized = this._normalizeSourceConfig(config);
    } catch (e) {
      return { success: false, error: e.message };
    }
    // id 必须与 sourceId 一致（不允许通过 updateSource 修改 id）
    if (normalized.id !== sid) {
      return { success: false, error: '源 id 与配置不一致，不能修改 id' };
    }

    const userSources = this._readUserSources();
    const idx = userSources.findIndex(s => s.id === sid);
    if (idx === -1) {
      // 用户配置中不存在（可能是默认源），新增一条覆盖配置
      userSources.push(normalized);
    } else {
      userSources[idx] = normalized;
    }

    if (!this._writeUserSources(userSources)) {
      return { success: false, error: '写入用户配置文件失败' };
    }

    // 同步内存
    const memIdx = this.sources.findIndex(s => s.id === sid);
    if (memIdx !== -1) {
      this.sources[memIdx] = { ...normalized, available: null };
    }

    safeLog(`[CmsApi] 更新数据源: ${normalized.name} (${normalized.id})`);
    return { success: true, source: normalized };
  }

  // 删除指定数据源
  // 返回 { success, removed?, error? }
  removeSource(sourceId) {
    const sid = String(sourceId || '').trim();
    if (!sid) return { success: false, error: '源 id 不能为空' };

    const userSources = this._readUserSources();
    const idx = userSources.findIndex(s => s.id === sid);
    if (idx === -1) {
      return { success: false, error: '该源不在用户配置中（可能是默认源，无法删除）' };
    }
    const removed = userSources.splice(idx, 1)[0];
    if (!this._writeUserSources(userSources)) {
      return { success: false, error: '写入用户配置文件失败' };
    }

    // 同步内存：如果是默认源，从内存中移除后下次 reload 会恢复默认
    const memIdx = this.sources.findIndex(s => s.id === sid);
    if (memIdx !== -1) {
      const packSource = this.packSources.find(source => source.id === sid);
      if (packSource) {
        this.sources[memIdx] = { ...packSource, isCustom: false, available: null };
      } else {
        this.sources.splice(memIdx, 1);
        if (this.currentSourceId === sid) {
          this.currentSourceId = this.sources.length > 0 ? this.sources[0].id : null;
        }
      }
    }

    safeLog(`[CmsApi] 删除数据源: ${removed.name} (${removed.id})`);
    return { success: true, removed };
  }

  // 导出用户配置 JSON 字符串（仅用户自定义源）
  // 返回 { success, json, count }
  exportSources(options = {}) {
    const includeBuiltIn = options.includeBuiltIn === true;
    const userSources = includeBuiltIn
      ? this.sources.map(source => this._normalizeSourceConfig(source))
      : this._readUserSources();
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      note: 'SAKURAFALL数据源配置导出文件',
      sources: userSources
    };
    return {
      success: true,
      json: JSON.stringify(payload, null, 2),
      count: userSources.length
    };
  }

  // 导入数据源 JSON 字符串
  // options: { overwrite?: boolean } - 是否覆盖同名 id（默认 true）
  // 返回 { success, added, overwritten, skipped, errors }
  importSources(jsonString, options = {}) {
    const overwrite = options.overwrite !== false;
    if (typeof jsonString !== 'string' || !jsonString.trim()) {
      return { success: false, error: '导入内容为空', added: 0, overwritten: 0, skipped: 0, errors: [] };
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (e) {
      return { success: false, error: 'JSON 格式无效: ' + e.message, added: 0, overwritten: 0, skipped: 0, errors: [] };
    }

    let incomingSources = [];
    if (Array.isArray(parsed)) {
      incomingSources = parsed;
    } else if (parsed && Array.isArray(parsed.sources)) {
      incomingSources = parsed.sources;
    } else {
      return { success: false, error: 'JSON 顶层必须是数组或 { sources: [...] } 对象', added: 0, overwritten: 0, skipped: 0, errors: [] };
    }

    const errors = [];
    const validIncoming = [];
    for (const raw of incomingSources) {
      try {
        validIncoming.push(this._normalizeSourceConfig(raw));
      } catch (e) {
        errors.push(`源 "${raw?.name || raw?.id || '?'}": ${e.message}`);
      }
    }

    const userSources = this._readUserSources();
    let added = 0;
    let overwritten = 0;
    let skipped = 0;

    for (const incoming of validIncoming) {
      const idx = userSources.findIndex(s => s.id === incoming.id);
      if (idx === -1) {
        userSources.push(incoming);
        added++;
      } else if (overwrite) {
        userSources[idx] = incoming;
        overwritten++;
      } else {
        skipped++;
      }
    }

    if (added === 0 && overwritten === 0 && skipped === 0) {
      return { success: false, error: '没有可导入的有效源', added, overwritten, skipped, errors };
    }

    if (!this._writeUserSources(userSources)) {
      return { success: false, error: '写入用户配置文件失败', added: 0, overwritten: 0, skipped: 0, errors };
    }

    // 同步内存：重新加载合并
    this._loadSources();

    safeLog(`[CmsApi] 导入数据源完成: 新增 ${added}, 覆盖 ${overwritten}, 跳过 ${skipped}, 错误 ${errors.length}`);
    return { success: true, added, overwritten, skipped, errors };
  }

  // 获取源配置文件信息，供设置页展示
  getSourcesConfigInfo() {
    return {
      defaultConfigPath: '',
      userConfigPath: this._getUserConfigPath(),
      userConfigExists: fs.existsSync(this._getUserConfigPath()),
      sourcePackCount: new Set(this.packSources.map(source => source.sourcePackId).filter(Boolean)).size
    };
  }

  // 确保用户自定义配置文件存在，不存在则写入一个示例模板
  ensureUserConfigFile() {
    const userPath = this._getUserConfigPath();
    if (!fs.existsSync(userPath)) {
      const example = {
        version: 1,
        note: '在此添加自定义 CMS 源。格式与默认配置相同，id 不可重复。修改后返回设置页点击"刷新源"。',
        sources: [
          {
            id: 'custom-demo',
            name: '自定义源示例（请修改）',
            api: 'https://example.com/api.php/provide/vod/',
            categories: [
              { id: '30', name: '日韩动漫' },
              { id: '29', name: '国产动漫' }
            ],
            defaultCategory: '30'
          }
        ]
      };
      fs.writeFileSync(userPath, JSON.stringify(example, null, 2), 'utf8');
    }
    return userPath;
  }

  // 获取当前源配置
  _currentSource() {
    return this.sources.find(s => s.id === this.currentSourceId);
  }

  // 设置当前源
  setSource(sourceId) {
    const source = this.sources.find(s => s.id === sourceId);
    if (source) {
      this.currentSourceId = sourceId;
      safeLog('[CmsApi] 切换到源:', source.name);
      return true;
    }
    return false;
  }

  // 获取源列表
  // displayName: 前端展示用的脱敏名称（首个=默认资源，其余按位置=源二/源三...）
  // name: 真实源名称，仅用于后端日志和调试
  getSourceList() {
    const chineseNum = ['', '二', '三', '四', '五', '六', '七', '八', '九', '十',
      '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
    return this.sources.map((s, idx) => {
      let displayName;
      if (idx === 0) {
        displayName = '默认资源';
      } else if (idx < chineseNum.length) {
        displayName = `源${chineseNum[idx]}`;
      } else {
        displayName = `源${idx + 1}`;
      }
      return {
        id: s.id,
        name: s.name,
        displayName,
        available: s.available,
        health: this._getSourceHealth(s.id),
        categories: s.categories,
        resolverId: s.resolverId || '',
        roles: s.roles || [],
        preference: s.preference || 0,
        requestHeaders: s.requestHeaders || {},
        playbackHeaders: s.playbackHeaders || {},
        sourcePackId: s.sourcePackId || '',
        isCustom: s.isCustom === true
      };
    });
  }

  getSourceConfig(sourceId) {
    return this.sources.find(source => source.id === sourceId) || null;
  }

  _getSourceHealth(sourceId) {
    return this._healthTracker.getHealth(sourceId);
  }

  _resetSourceHealth(sourceId) {
    const prev = this.sourceHealth.get(sourceId);
    if (!prev) return;
    this.sourceHealth.set(sourceId, {
      ...prev,
      failureCount: 0,
      cooldownUntil: 0,
      reason: ''
    });
    this._scheduleSourceHealthSave();
  }

  _average(prevValue, nextValue, prevCount = 0) {
    const value = Number(nextValue);
    if (!Number.isFinite(value) || value <= 0) return prevValue || 0;
    const count = Math.max(0, Number(prevCount) || 0);
    if (count <= 0 || !prevValue) return value;
    return (prevValue * count + value) / (count + 1);
  }

  _markSourceSuccess(sourceId, meta = {}) {
    return this._healthTracker.markSuccess(sourceId, meta);
  }

  _markSourcePlaybackFailure(sourceId, error) {
    return this._healthTracker.markPlaybackFailure(sourceId, error);
  }

  calculateSourceHealthScore(sourceId) {
    return this._healthTracker.calculateSourceHealthScore(sourceId);
  }

  recordPlaybackResult(sourceId, result = {}) {
    return this._healthTracker.recordPlaybackResult(sourceId, result);
  }

  _sourceCooldownReason(message) {
    const text = String(message || '');
    if (text.includes('暂不支持搜索')) {
      return { ttl: this.UNSUPPORTED_SEARCH_TTL, reason: '暂不支持搜索' };
    }
    if (/403|Forbidden/i.test(text)) {
      return { ttl: 30 * 60 * 1000, reason: '源站拒绝访问' };
    }
    if (/404|Not Found/i.test(text)) {
      return { ttl: 30 * 60 * 1000, reason: '接口不存在' };
    }
    if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(text)) {
      return { ttl: 5 * 60 * 1000, reason: '网络连接失败' };
    }
    return { ttl: this.SOURCE_COOLDOWN_TTL, reason: '搜索失败' };
  }

  _markSourceFailure(sourceId, error) {
    return this._healthTracker.markFailure(sourceId, error);
  }

  _isSourceCoolingDown(sourceId) {
    return this._healthTracker.isCoolingDown(sourceId);
  }

  // 安全解析 JSON，源返回 HTML 错误页时给出更清晰的信息
  _parseJson(text, context = '') {
    try {
      return JSON.parse(text);
    } catch (e) {
      const preview = String(text).slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`${context} JSON 解析失败: ${e.message} (响应: ${preview})`);
    }
  }

  // HTTP 请求：委托给公共 HttpClient，referer 作为参数传入
  async fetch(url, referer, options = {}) {
    return this.http.fetch(url, { referer: referer || '', ...options });
  }

  // 解析 CMS API 的 vod_play_url 字段
  // 格式: "第01集$url1#第02集$url2$$$线路2名$第01集$url3#第02集$url4"
  parseEpisodes(vodPlayFrom, vodPlayUrl) {
    return this._parser.parseEpisodes(vodPlayFrom, vodPlayUrl);
  }

  _mapVodItem(vod, sourceId) {
    return this._parser.mapVodItem(vod, sourceId);
  }

  _mapVodListItem(vod, sourceId) {
    return this._parser.mapVodListItem(vod, sourceId);
  }

  _mapVodDetail(vod, sourceId) {
    return this._parser.mapVodDetail(vod, sourceId);
  }

  // 获取分类列表
  async getCategories(options = {}) {
    const source = options.sourceId
      ? this.sources.find(item => item.id === options.sourceId)
      : this._currentSource();
    if (!source) return [];
    return source.categories || [];
  }

  // 获取动漫列表
  // 注：使用 ac=detail 而非 ac=list，因为 ac=list 不返回 vod_pic（封面）字段，
  // 会导致多源聚合模式下列表无封面。ac=detail 一次返回封面、简介、播放地址，
  // 与 search 方法行为一致，列表项可直接播放，无需二次抓详情补封面。
  // 缓存策略：5 分钟内命中缓存直接返回，避免频繁请求源站
  async getList(categoryId, page = 1, options = {}) {
    const source = options.sourceId
      ? this.sources.find(item => item.id === options.sourceId)
      : this._currentSource();
    if (!source) throw new Error('未选择数据源');

    // 命中缓存则直接返回（除非显式要求刷新）
    const cacheKey = this._listCacheKey(source.id, categoryId, page);
    if (!options.refresh) {
      const cached = this._readCache(cacheKey);
      if (cached) {
        safeLog('[CmsApi] 列表命中缓存:', source.name, `cat=${categoryId} pg=${page}`);
        return { ...cached, _fromCache: true };
      }
    }

    try {
      const params = new URLSearchParams({ ac: 'detail', pg: String(page) });
      if (categoryId) params.set('t', categoryId);

      const url = `${source.api}?${params.toString()}`;
      safeLog('[CmsApi] 获取列表:', source.name, url);

      const startedAt = Date.now();
      const text = await this.fetch(url, source.api);
      const data = this._parseJson(text, '[CmsApi]');

      const list = (data.list || []).map(vod => this._mapVodListItem(vod, source.id));
      const pageCount = data.pagecount || Math.ceil((data.total || 0) / 20) || 1;

      // 标记源为可用
      source.available = true;
      this._markSourceSuccess(source.id, { latencyMs: Date.now() - startedAt });

      const result = {
        data: list,
        page: data.page || page,
        total: data.total || 0,
        totalPages: pageCount,
        hasMore: (data.page || page) < pageCount
      };

      // 写入缓存
      this._writeCache(cacheKey, source.id, 'list', result, this.LIST_CACHE_TTL);

      return result;
    } catch (error) {
      safeError('[CmsApi] 获取列表失败:', source.name, error.message);
      source.available = false;
      this._markSourceFailure(source.id, error);
      throw error;
    }
  }

  // 获取动漫详情
  // 缓存策略：30 分钟内命中缓存直接返回；详情含播放地址，TTL 不宜过长
  async getDetail(id, options = {}) {
    // 优先使用传入的 sourceId（点击某条动漫时该动漫可能不属于当前选中源）
    const source = options.sourceId
      ? this.sources.find(s => s.id === options.sourceId)
      : this._currentSource();
    if (!source) throw new Error('未选择数据源');

    const cacheKey = this._detailCacheKey(source.id, id);
    if (!options.refresh) {
      const cached = this._readCache(cacheKey);
      if (cached) {
        safeLog('[CmsApi] 详情命中缓存:', source.name, `id=${id}`);
        return { ...cached, _fromCache: true };
      }
    }

    try {
      // 先尝试用 detail 接口获取完整数据
      const params = new URLSearchParams({ ac: 'detail', ids: String(id) });
      const url = `${source.api}?${params.toString()}`;
      safeLog('[CmsApi] 获取详情:', source.name, url);

      const startedAt = Date.now();
      const text = await this.fetch(url, source.api);
      const data = this._parseJson(text, '[CmsApi]');

      if (data.list && data.list.length > 0) {
        const detail = this._mapVodDetail(data.list[0], source.id);
        source.available = true;
        this._markSourceSuccess(source.id, { latencyMs: Date.now() - startedAt });
        this._writeCache(cacheKey, source.id, 'detail', detail, this.DETAIL_CACHE_TTL);
        return detail;
      }

      return null;
    } catch (error) {
      safeError('[CmsApi] 获取详情失败:', source.name, error.message);
      throw error;
    }
  }

  // 搜索
  async search(keyword, page = 1) {
    const source = this._currentSource();
    if (!source) throw new Error('未选择数据源');

    try {
      // 搜索时用 detail 接口，返回的数据更完整（含播放地址）
      const params = new URLSearchParams({ ac: 'detail', wd: keyword, pg: String(page) });
      const url = `${source.api}?${params.toString()}`;
      safeLog('[CmsApi] 搜索:', source.name, keyword);

      const startedAt = Date.now();
      const text = await this.fetch(url, source.api);
      const data = this._parseJson(text, '[CmsApi]');

      const list = (data.list || []).map(vod => this._mapVodDetail(vod, source.id));
      const pageCount = data.pagecount || Math.ceil((data.total || 0) / 20) || 1;

      source.available = true;
      this._markSourceSuccess(source.id, { latencyMs: Date.now() - startedAt });

      return {
        data: list,
        page: data.page || page,
        total: data.total || 0,
        totalPages: pageCount,
        keyword,
        hasMore: (data.page || page) < pageCount
      };
    } catch (error) {
      safeError('[CmsApi] 搜索失败:', source.name, error.message);
      source.available = false;
      this._markSourceFailure(source.id, error);
      throw error;
    }
  }

  // 在指定源中搜索（用于自动回退）
  async searchInSource(sourceId, keyword, page = 1, options = {}) {
    const source = this.sources.find(s => s.id === sourceId);
    if (!source) throw new Error(`源 ${sourceId} 不存在`);

    const cacheKey = this._searchCacheKey(sourceId, keyword, page);
    if (!options.refresh) {
      const cached = this._readCache(cacheKey);
      if (cached) return { ...cached, _fromCache: true };
    }

    try {
      const params = new URLSearchParams({ ac: 'detail', wd: keyword, pg: String(page) });
      const url = `${source.api}?${params.toString()}`;
      safeLog('[CmsApi] 在源中搜索:', source.name, keyword);

      const startedAt = Date.now();
      const text = await this.fetch(url, source.api, { signal: options.signal });
      const data = this._parseJson(text, '[CmsApi]');

      const list = (data.list || []).map(vod => this._mapVodDetail(vod, sourceId));
      const pageCount = data.pagecount || Math.ceil((data.total || 0) / 20) || 1;

      source.available = true;
      this._markSourceSuccess(sourceId, { latencyMs: Date.now() - startedAt });

      const result = {
        data: list,
        page: data.page || page,
        total: data.total || 0,
        totalPages: pageCount,
        keyword,
        hasMore: (data.page || page) < pageCount,
        sourceId
      };
      this._writeCache(cacheKey, source.id, 'search', result, this.SEARCH_CACHE_TTL);
      return result;
    } catch (error) {
      if (this._isAbortError(error)) throw error;
      safeError('[CmsApi] 在源中搜索失败:', source.name, error.message);
      source.available = false;
      this._markSourceFailure(sourceId, error);
      throw error;
    }
  }

  normalizeEpisodeTitle(title) {
    return this._parser.normalizeEpisodeTitle(title);
  }

  extractEpisodeNumber(title) {
    return this._parser.extractEpisodeNumber(title);
  }

  findMatchingEpisode(episodesByLine, targetTitle, targetIndex = -1) {
    return this._parser.findMatchingEpisode(episodesByLine, targetTitle, targetIndex);
  }

  firstPlayableEpisode(episodesByLine) {
    return this._parser.firstPlayableEpisode(episodesByLine);
  }

  parseM3u8Quality(text, playlistUrl = '') {
    return this._parser.parseM3u8Quality(text, playlistUrl);
  }

  guessQualityFromUrl(url) {
    return this._parser.guessQualityFromUrl(url);
  }

  _resolveUrl(value, baseUrl) {
    return this._parser.resolveUrl(value, baseUrl);
  }

  async probeStreamQuality(url, referer = '', options = {}) {
    this._throwIfAborted(options.signal);
    let playUrl = String(url || '').trim();
    try {
      playUrl = new URL(playUrl).toString();
    } catch (_) {
      // The validation below returns an explicit invalid result.
    }
    if (!playUrl || !/^https?:\/\//i.test(playUrl)) {
      return { width: 0, height: 0, bitrate: 0, variants: 0, source: 'invalid' };
    }

    const guessedHeight = this.guessQualityFromUrl(playUrl);
    if (!/\.m3u8(?:\?|$)/i.test(playUrl)) {
      return { width: 0, height: guessedHeight, bitrate: 0, variants: 0, source: guessedHeight ? 'url' : 'unknown' };
    }

    try {
      const text = await this.fetch(playUrl, referer || playUrl, {
        timeout: this.QUALITY_PROBE_TIMEOUT,
        headers: {
          ...(options.headers || {}),
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*'
        },
        signal: options.signal
      });
      if (!String(text || '').trimStart().startsWith('#EXTM3U')) {
        throw new Error('INVALID_M3U8_MANIFEST: 视频地址返回的不是 m3u8 清单');
      }
      const quality = this.parseM3u8Quality(text, playUrl);
      if (!quality.height && guessedHeight) {
        quality.height = guessedHeight;
        quality.source = 'url';
      }
      return quality;
    } catch (error) {
      if (this._isAbortError(error)) throw error;
      return { width: 0, height: guessedHeight, bitrate: 0, variants: 0, source: 'probe-failed', error: error.message };
    }
  }

  qualityScore(quality = {}) {
    return (quality.height || 0) * 100000 + (quality.bitrate || 0);
  }

  // 在所有源中搜索同名番（用于回退查找）
  async searchAllSources(keyword, options = {}) {
    const results = [];
    const skipped = [];
    const excludeSourceIds = new Set(options.excludeSourceIds || []);
    const searchableSources = this.sources.filter(source => {
      if (excludeSourceIds.has(source.id)) return false;
      if (this._isSourceCoolingDown(source.id)) {
        const health = this._getSourceHealth(source.id);
        skipped.push({ sourceId: source.id, sourceName: source.name, reason: health.reason, cooldownUntil: health.cooldownUntil });
        return false;
      }
      return true;
    });

    await this._mapWithConcurrency(
      searchableSources,
      options.concurrency || this.SEARCH_CONCURRENCY,
      async (source) => {
        try {
          const result = await this.searchInSource(source.id, keyword, 1, { signal: options.signal });
          if (result.data && result.data.length > 0) {
            results.push({
              sourceId: source.id,
              sourceName: source.name,
              data: result.data
            });
          }
        } catch (e) {
          if (this._isAbortError(e)) throw e;
          // 忽略失败的源
        }
      },
      options.signal
    );
    results.sort((a, b) => this.sources.findIndex(s => s.id === a.sourceId) - this.sources.findIndex(s => s.id === b.sourceId));
    if (options.includeSkipped) {
      return { results, skipped };
    }
    return results;
  }

  /**
   * 全源搜索并返回每个源的完整状态（Phase 3：per-source 状态隔离）
   * 返回 SourceSearchStatus[]，符合 docs/desktop-modernization-plan.md 5.3 节
   * status: pending | success | noResult | error | disabled
   */
  async searchAllSourcesWithStatus(keyword, options = {}) {
    const excludeSourceIds = new Set(options.excludeSourceIds || []);
    const searchableSources = this.sources.filter(source => {
      if (excludeSourceIds.has(source.id)) return false;
      return true;
    });

    // 初始化所有源为 pending 状态
    const statusList = searchableSources.map(source => {
      const health = this._getSourceHealth(source.id);
      const coolingDown = this._isSourceCoolingDown(source.id);
      return {
        sourceId: source.id,
        sourceName: source.name,
        type: 'cms-api',
        status: coolingDown ? 'disabled' : 'pending',
        keyword,
        count: 0,
        error: coolingDown ? (health.reason || '源冷却中') : '',
        elapsedMs: 0,
        results: [],
        confidence: 0
      };
    });

    // 并发搜索，每个源独立超时和错误隔离
    await this._mapWithConcurrency(
      searchableSources,
      options.concurrency || this.SEARCH_CONCURRENCY,
      async (source) => {
        const entry = statusList.find(s => s.sourceId === source.id);
        if (!entry || entry.status === 'disabled') return;

        const startedAt = Date.now();
        try {
          const result = await this.searchInSource(source.id, keyword, 1, { signal: options.signal });
          entry.elapsedMs = Date.now() - startedAt;
          if (result.data && result.data.length > 0) {
            entry.status = 'success';
            entry.count = result.data.length;
            entry.results = result.data;
            // 计算第一条结果的置信度
            entry.confidence = this._computeConfidence(keyword, result.data[0]);
          } else {
            entry.status = 'noResult';
          }
        } catch (e) {
          if (this._isAbortError(e)) throw e;
          entry.elapsedMs = Date.now() - startedAt;
          entry.status = 'error';
          entry.error = e.message || '搜索失败';
        }
      },
      options.signal
    );

    // 按置信度降序排序，无结果/失败的源排后面
    statusList.sort((a, b) => {
      const order = { success: 0, noResult: 1, error: 2, disabled: 3, pending: 4 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return (b.confidence || 0) - (a.confidence || 0);
    });

    return statusList;
  }

  /**
   * 计算搜索结果与关键词的置信度（0-1）
   */
  _computeConfidence(keyword, anime) {
    if (!anime || !keyword) return 0.5;
    const kw = String(keyword).toLowerCase().trim();
    const name = String(anime.name || anime.title || '').toLowerCase().trim();
    const nameRaw = String(anime.name_raw || '').toLowerCase().trim();
    if (!name && !nameRaw) return 0.5;
    // 完全匹配
    if (name === kw || nameRaw === kw) return 0.95;
    // 包含关系
    if (name.includes(kw) || nameRaw.includes(kw)) return 0.85;
    if (kw.includes(name) || kw.includes(nameRaw)) return 0.80;
    // 其他
    return 0.5;
  }


  collectEpisodeCandidates(searchResults, target = {}) {
    const candidates = [];
    const targetIndex = Number.parseInt(target.episodeIndex, 10);
    const mayUseFirstEpisode = target.allowFirstFallback !== false
      && (!Number.isFinite(targetIndex) || targetIndex <= 0);

    for (const sourceResult of searchResults || []) {
      const rankedAnime = (sourceResult.data || [])
        .map((anime, originalIndex) => ({
          anime,
          originalIndex,
          titleMatch: target.keyword
            ? scoreTitleMatch(target.keyword, anime?.name || anime?.title || '')
            : { score: 1, reliable: true, exact: true }
        }))
        .filter(item => item.titleMatch.reliable)
        .sort((a, b) => (
          (Number(b.titleMatch.exact) - Number(a.titleMatch.exact))
          || (b.titleMatch.score - a.titleMatch.score)
          || (a.originalIndex - b.originalIndex)
        ));

      // Keep one playable work per provider so fallback is genuinely cross-source.
      for (const { anime, titleMatch } of rankedAnime) {
        if (!anime || !anime.episodes || Object.keys(anime.episodes).length === 0) continue;
        const matched = this.findMatchingEpisode(anime.episodes, target.episodeTitle, target.episodeIndex);
        const selected = matched || (mayUseFirstEpisode ? this.firstPlayableEpisode(anime.episodes) : null);
        if (!selected) continue;

        const url = selected.episode.url || selected.episode.play_url;
        if (!url || !/^https?:\/\//i.test(url)) continue;

        candidates.push({
          sourceId: sourceResult.sourceId,
          sourceName: sourceResult.sourceName,
          anime,
          episode: selected.episode,
          lineId: selected.lineId,
          matchType: selected.matchType,
          matchScore: selected.matchScore,
          titleMatchScore: titleMatch.score,
          titleMatchExact: titleMatch.exact,
          url
        });
        break;
      }
    }
    return candidates;
  }

  serializeEpisodeCandidate(candidate) {
    return {
      sourceId: candidate.sourceId,
      providerId: `cms:${candidate.sourceId}`,
      sourceName: candidate.sourceName,
      sourceType: 'cms',
      animeName: candidate.anime?.name || '',
      episodeTitle: candidate.episode?.title || '',
      matchType: candidate.matchType,
      lineId: candidate.lineId,
      url: candidate.url,
      anime: candidate.anime,
      episode: candidate.episode,
      healthScore: candidate.healthScore ?? this.calculateSourceHealthScore(candidate.sourceId),
      health: candidate.health || this._getSourceHealth(candidate.sourceId),
      preference: candidate.preference || 0,
      titleMatchScore: candidate.titleMatchScore,
      titleMatchExact: candidate.titleMatchExact,
      quality: candidate.quality,
      score: candidate.score
    };
  }

  async selectBestEpisodeSource(keyword, target = {}) {
    const task = this._startScopedTask(target.taskScope || 'selectBestEpisodeSource');
    const signal = task.signal;

    try {
      const searchData = await this.searchAllSources(keyword, {
        excludeSourceIds: target.excludeSourceIds || [],
        includeSkipped: true,
        concurrency: target.searchConcurrency || this.SEARCH_CONCURRENCY,
        signal
      });
      this._throwIfAborted(signal);

      const candidates = this.collectEpisodeCandidates(searchData.results, {
        keyword,
        episodeTitle: target.episodeTitle || '',
        episodeIndex: target.episodeIndex ?? -1,
        allowFirstFallback: target.allowFirstFallback !== false
      });

      if (candidates.length === 0) {
        return { best: null, candidates: [], skipped: searchData.skipped };
      }

      const probeLimit = Math.max(1, Math.min(parseInt(target.probeLimit, 10) || 8, 12));
      const prioritized = candidates
        .sort((a, b) =>
          (Number(b.titleMatchExact) - Number(a.titleMatchExact)) ||
          (b.titleMatchScore - a.titleMatchScore) ||
          (b.matchScore - a.matchScore) ||
          (this.calculateSourceHealthScore(b.sourceId) - this.calculateSourceHealthScore(a.sourceId)) ||
          (this.sources.findIndex(s => s.id === a.sourceId) - this.sources.findIndex(s => s.id === b.sourceId))
        )
        .slice(0, probeLimit);

      await this._mapWithConcurrency(
        prioritized,
        target.probeConcurrency || this.QUALITY_PROBE_CONCURRENCY,
        async (candidate) => {
          const sourceConfig = this.getSourceConfig(candidate.sourceId);
          let sourceReferer = '';
          try {
            sourceReferer = sourceConfig?.api ? `${new URL(sourceConfig.api).origin}/` : '';
          } catch (_) {
            sourceReferer = '';
          }
          const playbackHeaders = sourceConfig?.playbackHeaders || {};
          const probeReferer = playbackHeaders.Referer || playbackHeaders.referer || sourceReferer;
          candidate.quality = /\/share\//i.test(candidate.url)
            ? { width: 0, height: 0, bitrate: 0, variants: 0, source: 'resolver-required' }
            : await this.probeStreamQuality(candidate.url, probeReferer, {
              headers: playbackHeaders,
              signal
            });
          candidate.health = this._getSourceHealth(candidate.sourceId);
          candidate.healthScore = candidate.health.score;
          candidate.preference = Number(sourceConfig?.preference) || 0;
          candidate.score = candidate.titleMatchScore * 1000000000000
            + candidate.matchScore * 1000000000
            + candidate.healthScore * 1000000
            + candidate.preference * 1000000
            + this.qualityScore(candidate.quality);
        },
        signal
      );

      const viableCandidates = [];
      for (const candidate of prioritized) {
        if (candidate.quality?.error || candidate.quality?.source === 'probe-failed') {
          this.recordPlaybackResult(candidate.sourceId, {
            success: false,
            reason: 'preflight-failed',
            error: candidate.quality?.error || '视频流预检失败'
          });
          continue;
        }
        viableCandidates.push(candidate);
      }

      viableCandidates.sort((a, b) => (b.score - a.score) || (b.matchScore - a.matchScore));
      const best = viableCandidates[0] || null;
      return {
        best,
        candidates: viableCandidates.slice(0, 12).map(candidate => this.serializeEpisodeCandidate(candidate)),
        skipped: searchData.skipped
      };
    } catch (error) {
      if (this._isAbortError(error)) {
        return { best: null, candidates: [], skipped: [], cancelled: true };
      }
      throw error;
    } finally {
      this._finishScopedTask(task);
    }
  }

  // 清理接口缓存
  // options: { sourceId?, kind?, expiredOnly? }
  clearCache(options = {}) {
    if (!this.db) return 0;
    try {
      return this.db.clearCache(options);
    } catch (e) {
      safeError('[CmsApi] 清理缓存失败:', e.message);
      return 0;
    }
  }

  // 测试当前源连通性
  async test() {
    const source = this._currentSource();
    if (!source) return { success: false, message: '未选择数据源' };

    try {
      const start = Date.now();
      const url = `${source.api}?ac=list&pg=1`;
      const text = await this.fetch(url, source.api);
      const data = this._parseJson(text, '[CmsApi]');
      const success = data.list && data.list.length > 0;
      source.available = success;
      if (success) {
        this._markSourceSuccess(source.id, { latencyMs: Date.now() - start });
      } else {
        this._markSourceFailure(source.id, 'invalid data');
      }
      return {
        success,
        time: Date.now() - start,
        message: success ? `${source.name} 连接成功` : '数据格式异常',
        sourceName: source.name,
        health: this._getSourceHealth(source.id)
      };
    } catch (error) {
      source.available = false;
      this._markSourceFailure(source.id, error);
      return { success: false, message: error.message, sourceName: source.name, health: this._getSourceHealth(source.id) };
    }
  }

  // 测试所有源连通性（并行，避免逐源串行等待累加超时）
  async testAll() {
    const settled = await Promise.allSettled(
      this.sources.map(async (source) => {
        const start = Date.now();
        try {
          const url = `${source.api}?ac=list&pg=1`;
          const text = await this.fetch(url, source.api);
          const data = this._parseJson(text, '[CmsApi]');
          const success = data.list && data.list.length > 0;
          source.available = success;
          if (success) {
            this._markSourceSuccess(source.id, { latencyMs: Date.now() - start });
          } else {
            this._markSourceFailure(source.id, 'invalid data');
          }
          return {
            id: source.id,
            name: source.name,
            success,
            time: Date.now() - start,
            message: success ? '连接成功' : '数据格式异常',
            health: this._getSourceHealth(source.id)
          };
        } catch (error) {
          source.available = false;
          this._markSourceFailure(source.id, error);
          return {
            id: source.id,
            name: source.name,
            success: false,
            message: error.message,
            health: this._getSourceHealth(source.id)
          };
        }
      })
    );
    return settled.map(r => r.value);
  }
}

module.exports = new CmsApiService();
module.exports.CmsApiService = CmsApiService;
