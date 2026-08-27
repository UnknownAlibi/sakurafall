/**
 * Phase 4: 插件式源管理器
 *
 * 管理 XPath 规则源的生命周期：
 *   - 加载默认规则（src/main/config/source-plugins/*.json）
 *   - 加载用户规则（userData/plugin-sources.json，按 id 覆盖默认）
 *   - 增删改查、启用/禁用、导入/导出
 *   - 委托 SourceRuleEngine 执行 search/parseDetail/test
 *
 * 与 CmsApiService 并存，互不影响。CMS 源继续走 cms-* 通道，
 * 插件源走 plugin-* 通道。
 */
const fs = require('fs');
const path = require('path');
const { SourceRuleEngine } = require('./SourceRuleEngine');
const { isXPathRule } = require('./sources/XPathRuleAdapter');

class SourcePluginManager {
    /**
     * @param {object} options
     * @param {object} options.ruleEngine - SourceRuleEngine 实例（共享 HttpClient）
     */
    constructor(options = {}) {
        this.ruleEngine = options.ruleEngine || new SourceRuleEngine(options);
        this.rules = new Map();          // id -> 规则对象（已校验）
        this.packRules = [];
        this.defaultDir = null;          // 默认规则目录（src/main/config/source-plugins）
        this.userConfigPath = null;      // 用户规则文件（userData/plugin-sources.json）
        this._saveTimer = null;
    }

    // ===== 初始化 =====

    /**
     * 设置存储路径并加载规则
     * @param {object} paths
     * @param {string} paths.defaultDir - 默认规则目录
     * @param {string} paths.userConfigPath - 用户规则 JSON 文件路径
     */
    setStorePaths(paths = {}) {
        this.defaultDir = paths.defaultDir || null;
        this.userConfigPath = paths.userConfigPath || null;
        this._loadAll();
    }

    setPackRules(rules = []) {
        this.packRules = Array.isArray(rules) ? rules.map(rule => ({ ...rule })) : [];
        this._loadAll();
        return this.getAllForManagement();
    }

    _loadAll() {
        this.rules.clear();
        // 1. 加载片源包提供的规则。核心管理器不拥有具体站点规则。
        for (const raw of this.packRules) {
            const { valid, rule, error } = this.ruleEngine.validateRule(raw);
            if (!valid) {
                console.warn(`[SourcePluginManager] 片源包规则 ${raw?.id || '?'} 无效: ${error}`);
                continue;
            }
            rule._builtIn = true;
            rule._sourcePackId = raw.sourcePackId || '';
            this.rules.set(rule.id, rule);
        }

        // 2. 加载开发期默认规则目录（只用于模板和兼容）
        if (this.defaultDir && fs.existsSync(this.defaultDir)) {
            try {
                const files = fs.readdirSync(this.defaultDir)
                    .filter(f => f.endsWith('.json'));
                for (const file of files) {
                    try {
                        const raw = JSON.parse(
                            fs.readFileSync(path.join(this.defaultDir, file), 'utf8')
                        );
                        const { valid, rule, error } = this.ruleEngine.validateRule(raw);
                        if (valid) {
                            // 默认规则标记为不可删除
                            rule._builtIn = true;
                            this.rules.set(rule.id, rule);
                        } else {
                            console.warn(`[SourcePluginManager] 默认规则 ${file} 无效: ${error}`);
                        }
                    } catch (e) {
                        console.warn(`[SourcePluginManager] 默认规则 ${file} 解析失败:`, e.message);
                    }
                }
            } catch (e) {
                console.warn('[SourcePluginManager] 读取默认规则目录失败:', e.message);
            }
        }
        // 3. 加载用户规则（覆盖同名片源包规则）
        if (this.userConfigPath && fs.existsSync(this.userConfigPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.userConfigPath, 'utf8'));
                const userRules = Array.isArray(data) ? data : (data.rules || []);
                for (const raw of userRules) {
                    const { valid, rule, error } = this.ruleEngine.validateRule(raw);
                    if (valid) {
                        // 保留 _builtIn 标记（用户覆盖内置规则时仍不可删）
                        const existing = this.rules.get(rule.id);
                        if (existing && existing._builtIn) {
                            rule._builtIn = true;
                        }
                        this.rules.set(rule.id, rule);
                    } else {
                        console.warn(`[SourcePluginManager] 用户规则 ${raw.id} 无效: ${error}`);
                    }
                }
            } catch (e) {
                console.warn('[SourcePluginManager] 读取用户规则失败:', e.message);
            }
        }
    }

    _persistUserRules() {
        if (!this.userConfigPath) return;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                const dir = path.dirname(this.userConfigPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                // 只持久化非内置规则（内置规则由默认目录提供）
                const userRules = Array.from(this.rules.values())
                    .filter(r => !r._builtIn)
                    .map(r => this._serializeRule(r));
                const data = {
                    version: 1,
                    note: 'SAKURAFALL用户自定义 XPath 规则源',
                    rules: userRules
                };
                fs.writeFileSync(this.userConfigPath, JSON.stringify(data, null, 2), 'utf8');
            } catch (e) {
                console.error('[SourcePluginManager] 持久化用户规则失败:', e.message);
            }
        }, 200);
    }

    _serializeRule(rule) {
        // 去除内部字段
        const { _builtIn, _sourcePackId, ...rest } = rule;
        return rest;
    }

    // ===== 查询 =====

    /**
     * 获取所有规则列表
     * @param {object} options - { includeDisabled?: boolean }
     */
    getList(options = {}) {
        const list = [];
        for (const rule of this.rules.values()) {
            if (!options.includeDisabled && !rule.enabled) continue;
            const health = this.ruleEngine.getHealth(rule.id);
            list.push({
                id: rule.id,
                name: rule.name,
                type: rule.type,
                version: rule.version,
                enabled: rule.enabled,
                baseUrl: rule.baseUrl,
                isBuiltIn: !!rule._builtIn,
                hasDetail: !!rule.detail,
                compatibility: rule.compatibility ? { ...rule.compatibility } : null,
                playbackMode: rule.playback?.mode || '',
                adBlocker: rule.adBlocker === true,
                health
            });
        }
        return list;
    }

    /**
     * 获取所有规则（含禁用），用于管理页
     */
    getAllForManagement() {
        return this.getList({ includeDisabled: true });
    }

    getRule(id) {
        return this.rules.get(id) || null;
    }

    /**
     * 获取规则详情（不含内部字段）
     */
    getRuleDetail(id) {
        const rule = this.rules.get(id);
        if (!rule) return null;
        return this._serializeRule(rule);
    }

    getPlaybackHeaders(id) {
        const rule = this.rules.get(id);
        if (!rule) return {};
        const headers = { ...(rule.headers || {}) };
        if (!headers.Referer && !headers.referer) headers.Referer = `${rule.baseUrl}/`;
        return headers;
    }

    // ===== 增删改 =====

    /**
     * 新增规则
     * @returns {{ success, rule?, error? }}
     */
    addRule(raw) {
        const { valid, rule, error } = this.ruleEngine.validateRule(raw);
        if (!valid) return { success: false, error };
        if (this.rules.has(rule.id)) {
            return { success: false, error: `规则 id '${rule.id}' 已存在` };
        }
        this.rules.set(rule.id, rule);
        this._persistUserRules();
        return { success: true, rule: this._serializeRule(rule) };
    }

    /**
     * 更新规则
     * @returns {{ success, rule?, error? }}
     */
    updateRule(id, raw) {
        const existing = this.rules.get(id);
        if (!existing) return { success: false, error: '规则不存在' };
        // id 不可变
        const updateRaw = Object.assign({}, raw, { id });
        const { valid, rule, error } = this.ruleEngine.validateRule(updateRaw);
        if (!valid) return { success: false, error };
        // 保留 _builtIn 标记
        if (existing._builtIn) rule._builtIn = true;
        this.rules.set(id, rule);
        this._persistUserRules();
        return { success: true, rule: this._serializeRule(rule) };
    }

    /**
     * 删除规则
     * @returns {{ success, removed?, error? }}
     */
    removeRule(id) {
        const existing = this.rules.get(id);
        if (!existing) return { success: false, error: '规则不存在' };
        if (existing._builtIn) {
            return { success: false, error: '内置规则不可删除（可禁用）' };
        }
        this.rules.delete(id);
        this.ruleEngine.clearHealth(id);
        this._persistUserRules();
        return { success: true, removed: id };
    }

    /**
     * 启用/禁用规则
     */
    setEnabled(id, enabled) {
        const rule = this.rules.get(id);
        if (!rule) return { success: false, error: '规则不存在' };
        rule.enabled = !!enabled;
        this._persistUserRules();
        return { success: true, enabled: rule.enabled };
    }

    // ===== 导入导出 =====

    /**
     * 导出所有规则为 JSON 字符串
     */
    exportRules() {
        const rules = Array.from(this.rules.values())
            .map(r => this._serializeRule(r));
        return {
            success: true,
            json: JSON.stringify({
                version: 1,
                exportedAt: new Date().toISOString(),
                rules
            }, null, 2),
            count: rules.length
        };
    }

    /**
     * 导入规则 JSON
     * @param {string} jsonString
     * @param {object} options - { overwrite?: boolean }
     */
    importRules(jsonString, options = {}) {
        const overwrite = options.overwrite !== false;
        const result = { success: true, added: 0, overwritten: 0, skipped: 0, errors: [] };
        let parsed;
        try {
            parsed = JSON.parse(jsonString);
        } catch (e) {
            return { success: false, error: 'JSON 解析失败: ' + e.message, ...result };
        }
        const rules = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed.rules) ? parsed.rules : [parsed]);
        result.format = rules.some(isXPathRule) ? 'xpath' : 'native';
        result.converted = 0;
        for (const raw of rules) {
            if (isXPathRule(raw)) result.converted++;
            const { valid, rule, error } = this.ruleEngine.validateRule(raw);
            if (!valid) {
                result.errors.push(`规则 ${raw.id || '(unknown)'}: ${error}`);
                result.skipped++;
                continue;
            }
            if (this.rules.has(rule.id) && !overwrite) {
                result.skipped++;
                continue;
            }
            // 覆盖内置规则时保留标记
            const existing = this.rules.get(rule.id);
            if (existing && existing._builtIn) rule._builtIn = true;
            this.rules.set(rule.id, rule);
            if (existing) result.overwritten++;
            else result.added++;
        }
        this._persistUserRules();
        return result;
    }

    // ===== 执行（委托 SourceRuleEngine） =====

    /**
     * 搜索
     */
    async search(id, keyword, options = {}) {
        const rule = this.rules.get(id);
        if (!rule) {
            return { success: false, error: '规则不存在', sourceId: id, data: [] };
        }
        if (!rule.enabled) {
            return { success: false, error: '规则已禁用', sourceId: id, data: [] };
        }
        return this.ruleEngine.search(rule, keyword, options);
    }

    /**
     * 解析详情页
     */
    async parseDetail(id, pageUrl, options = {}) {
        const rule = this.rules.get(id);
        if (!rule) {
            return { success: false, error: '规则不存在', episodes: [] };
        }
        return this.ruleEngine.parseDetail(rule, pageUrl, options);
    }

    /**
     * 测试单个规则
     */
    async test(id, options = {}) {
        const rule = this.rules.get(id);
        if (!rule) {
            return { success: false, time: 0, message: '规则不存在', sourceId: id, sourceName: id };
        }
        return this.ruleEngine.test(rule, options);
    }

    /**
     * 测试所有启用的规则
     */
    async testAll(options = {}) {
        const ids = Array.from(this.rules.values())
            .filter(r => r.enabled)
            .map(r => r.id);
        const results = await Promise.all(
            ids.map(id => this.test(id, options).catch(e => ({
                success: false,
                time: 0,
                message: e.message || String(e),
                sourceId: id,
                sourceName: id
            })))
        );
        return results;
    }

    /**
     * 并发搜索所有启用的规则
     * @returns {Promise<Array>} 每个规则一个结果对象
     */
    async searchAll(keyword, options = {}) {
        const enabledRules = Array.from(this.rules.values()).filter(r => r.enabled);
        const results = await Promise.all(
            enabledRules.map(rule =>
                this.ruleEngine.search(rule, keyword, options).catch(e => ({
                    success: false,
                    data: [],
                    keyword,
                    sourceId: rule.id,
                    sourceName: rule.name,
                    elapsedMs: 0,
                    error: e.message || String(e)
                }))
            )
        );
        return results;
    }
}

module.exports = { SourcePluginManager };
