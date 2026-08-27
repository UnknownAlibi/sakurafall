/**
 * Phase 4: 插件式源规则引擎
 *
 * 负责 XPath 类源规则的解析与执行：
 *   - 接收标准规则 JSON（见 docs/desktop-modernization-plan.md Phase 4 规则示例）
 *   - fetch HTML 页面
 *   - 用 @xmldom/xmldom 解析为 DOM
 *   - 用 xpath 库求值提取字段
 *   - 返回与 CMS 源可比的标准结构（SubjectSummary / PlayableSource.episodes）
 *
 * 与 CmsApiService 并存，互不影响。CMS 源继续走 cms-* 通道，
 * XPath 源走 plugin-* 通道。两者通过 SourceSearchService（Phase 3）统一调度。
 */
const xpath = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');
const { parseDocument } = require('htmlparser2');
const serializeHtml = require('dom-serializer').default;
const { adaptXPathRule, isXPathRule } = require('./sources/XPathRuleAdapter');

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class SourceRuleEngine {
    /**
     * @param {object} options
     * @param {object} options.httpClient - HttpClient 实例（复用代理/超时配置）
     */
    constructor(options = {}) {
        this.httpClient = options.httpClient;
        this.health = new Map(); // sourceId -> health record
    }

    // ===== 规则校验 =====

    /**
     * 校验并规范化规则配置
     * @param {object} raw - 原始规则对象
     * @returns {{ valid: boolean, rule?: object, error?: string }}
     */
    validateRule(raw) {
        if (!raw || typeof raw !== 'object') {
            return { valid: false, error: '规则必须是对象' };
        }
        if (isXPathRule(raw)) raw = adaptXPathRule(raw);
        const id = String(raw.id || '').trim();
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            return { valid: false, error: 'id 必须由字母/数字/下划线/连字符组成' };
        }
        const name = String(raw.name || '').trim();
        if (!name) {
            return { valid: false, error: 'name 不能为空' };
        }
        const type = String(raw.type || 'xpath').toLowerCase();
        if (type !== 'xpath') {
            return { valid: false, error: `不支持的 type: ${type}（当前仅支持 xpath）` };
        }
        const baseUrl = String(raw.baseUrl || '').trim();
        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            return { valid: false, error: 'baseUrl 必须是 http(s):// 开头的地址' };
        }
        if (!raw.search || typeof raw.search !== 'object') {
            return { valid: false, error: 'search 规则缺失' };
        }
        if (!raw.search.url || !raw.search.list) {
            return { valid: false, error: 'search.url 和 search.list 必填' };
        }
        // detail 规则可选（部分源只需搜索结果）
        const rule = {
            id,
            name,
            type,
            version: String(raw.version || '1.0.0'),
            enabled: raw.enabled !== false,
            baseUrl: baseUrl.replace(/\/+$/, ''),
            headers: this._normalizeHeaders(raw.headers, baseUrl),
            search: {
                url: raw.search.url,
                method: String(raw.search.method || 'GET').toUpperCase(),
                list: raw.search.list,
                name: raw.search.name,
                urlPath: raw.search.urlPath,
                cover: raw.search.cover,
                detailUrl: raw.search.detailUrl  // 可选：详情页链接（与 urlPath 区分时用）
            },
            detail: raw.detail || null,
            adBlocker: raw.adBlocker === true,
            playback: raw.playback && typeof raw.playback === 'object' ? { ...raw.playback } : null,
            compatibility: raw.compatibility && typeof raw.compatibility === 'object'
                ? { ...raw.compatibility }
                : null
        };
        return { valid: true, rule };
    }

    _normalizeHeaders(headers, baseUrl) {
        const out = {
            'User-Agent': DEFAULT_UA
        };
        if (headers && typeof headers === 'object') {
            for (const [k, v] of Object.entries(headers)) {
                out[k] = String(v).replace('@baseUrl', baseUrl);
            }
        }
        return out;
    }

    // ===== URL 构造 =====

    /**
     * 用上下文变量替换 URL 模板
     * @param {string} tmpl - URL 模板，如 '/search?keyword=@keyword&page=@page'
     * @param {object} vars - { keyword, page, baseUrl }
     */
    _buildUrl(tmpl, vars) {
        let url = String(tmpl)
            .replace('@keyword', encodeURIComponent(vars.keyword || ''))
            .replace('@page', encodeURIComponent(vars.page || 1));
        if (url.startsWith('http')) {
            return url;
        }
        return vars.baseUrl + (url.startsWith('/') ? url : '/' + url);
    }

    /**
     * 把相对 URL 拼成绝对 URL
     */
    _resolveUrl(base, relative) {
        if (!relative) return '';
        const rel = String(relative).trim();
        if (/^https?:\/\//i.test(rel)) return rel;
        if (rel.startsWith('//')) return 'https:' + rel;
        try {
            return new URL(rel, base).href;
        } catch (e) {
            return base.replace(/\/+$/, '') + (rel.startsWith('/') ? rel : '/' + rel);
        }
    }

    // ===== HTML 解析 =====

    /**
     * 用 xmldom 解析 HTML 字符串为 DOM
     * xmldom 对 HTML 容错较差，配置 errorHandler 忽略警告
     */
    _parseHtml(html) {
        const normalizedHtml = serializeHtml(parseDocument(String(html || ''), {
            decodeEntities: true
        }), {
            xmlMode: true,
            encodeEntities: 'utf8'
        });
        const parser = new DOMParser({
            onError: () => {}
        });
        return parser.parseFromString(normalizedHtml, 'application/xml');
    }

    /**
     * 在上下文节点上求值 XPath，返回字符串
     * 支持文本节点和属性节点
     */
    _evalString(expr, context) {
        if (!expr || !context) return '';
        try {
            const nodes = xpath.select(expr, context);
            if (!Array.isArray(nodes) || nodes.length === 0) return '';
            const node = nodes[0];
            // 文本节点 / 属性节点 / 元素节点统一取 nodeValue 或 textContent
            return String(node.nodeValue || node.textContent || '').trim();
        } catch (e) {
            return '';
        }
    }

    /**
     * 在上下文节点上求值 XPath，返回节点数组
     */
    _evalNodes(expr, context) {
        if (!expr || !context) return [];
        try {
            const nodes = xpath.select(expr, context);
            return Array.isArray(nodes) ? nodes : [];
        } catch (e) {
            return [];
        }
    }

    // ===== 搜索 =====

    /**
     * 执行搜索
     * @param {object} rule - 已校验的规则对象
     * @param {string} keyword - 搜索关键词
     * @param {object} options - { page?, signal? }
     * @returns {Promise<object>} { success, data, page, keyword, sourceId, sourceName, elapsedMs, error? }
     */
    async search(rule, keyword, options = {}) {
        const page = parseInt(options.page, 10) || 1;
        const start = Date.now();
        const url = this._buildUrl(rule.search.url, {
            keyword,
            page,
            baseUrl: rule.baseUrl
        });

        try {
            const html = await this._fetch(url, {
                method: rule.search.method,
                headers: rule.headers,
                keyword
            });
            const doc = this._parseHtml(html);
            const items = this._evalNodes(rule.search.list, doc);

            const data = items.map((node, idx) => {
                const name = this._evalString(rule.search.name, node);
                const linkExpr = rule.search.detailUrl || rule.search.urlPath;
                const link = this._evalString(linkExpr, node);
                const cover = this._evalString(rule.search.cover, node);
                return {
                    id: `${rule.id}_${idx + 1}`,
                    name,
                    cover: this._resolveUrl(rule.baseUrl, cover),
                    url: this._resolveUrl(rule.baseUrl, link),
                    sourceId: rule.id,
                    sourceName: rule.name
                };
            }).filter(item => item.name); // 必须有名字才算有效

            const elapsedMs = Date.now() - start;
            this._markSuccess(rule.id, elapsedMs);
            return {
                success: true,
                data,
                page,
                keyword,
                sourceId: rule.id,
                sourceName: rule.name,
                elapsedMs
            };
        } catch (error) {
            const elapsedMs = Date.now() - start;
            this._markFailure(rule.id, error);
            return {
                success: false,
                data: [],
                page,
                keyword,
                sourceId: rule.id,
                sourceName: rule.name,
                elapsedMs,
                error: error.message || String(error)
            };
        }
    }

    // ===== 详情解析 =====

    /**
     * 解析详情页，提取剧集列表
     * @param {object} rule - 已校验的规则对象
     * @param {string} pageUrl - 详情页 URL
     * @param {object} options - { signal? }
     * @returns {Promise<object>} { success, name, cover, episodes, elapsedMs, error? }
     *   episodes: [{ id, title, url, lineName }]
     */
    async parseDetail(rule, pageUrl) {
        const start = Date.now();
        if (!rule.detail) {
            return {
                success: false,
                error: '该源未配置 detail 规则，无法解析详情页',
                elapsedMs: 0
            };
        }

        try {
            const html = await this._fetch(pageUrl, {
                method: 'GET',
                headers: rule.headers
            });
            const doc = this._parseHtml(html);

            // 详情页可选字段：name / cover（用 search.name / search.cover 的 XPath 兜底）
            const name = this._evalString(rule.detail.name || rule.search.name, doc);
            const cover = this._resolveUrl(
                rule.baseUrl,
                this._evalString(rule.detail.cover || rule.search.cover, doc)
            );

            // 剧集分组（多线路）
            const groups = rule.detail.episodeGroups
                ? this._evalNodes(rule.detail.episodeGroups, doc)
                : [doc];

            const episodes = [];
            groups.forEach((group, gIdx) => {
                const lineName = (rule.detail.episodeGroupName &&
                    this._evalString(rule.detail.episodeGroupName, group)) ||
                    `线路${gIdx + 1}`;
                const epNodes = this._evalNodes(rule.detail.episodeList, group);
                epNodes.forEach((epNode, epIdx) => {
                    const title = this._evalString(rule.detail.episodeTitle, epNode);
                    const epUrl = this._evalString(rule.detail.episodeUrl, epNode);
                    if (title && epUrl) {
                        episodes.push({
                            id: `${rule.id}_${gIdx}_${epIdx + 1}`,
                            title,
                            url: this._resolveUrl(rule.baseUrl, epUrl),
                            lineName,
                            playbackMode: rule.playback?.mode || '',
                            useLegacyParser: rule.playback?.useLegacyParser === true,
                            adBlocker: rule.adBlocker === true
                        });
                    }
                });
            });

            const elapsedMs = Date.now() - start;
            this._markSuccess(rule.id, elapsedMs);
            return {
                success: true,
                name,
                cover,
                episodes,
                elapsedMs
            };
        } catch (error) {
            const elapsedMs = Date.now() - start;
            this._markFailure(rule.id, error);
            return {
                success: false,
                episodes: [],
                elapsedMs,
                error: error.message || String(error)
            };
        }
    }

    // ===== 测试 =====

    /**
     * 测试规则源可达性
     * @param {object} rule - 已校验的规则对象
     * @param {object} options - { signal? }
     * @returns {Promise<object>} { success, time, message, sourceId, sourceName }
     */
    async test(rule) {
        const start = Date.now();
        // 用空关键词或首页探测
        const testVars = { keyword: '', page: 1, baseUrl: rule.baseUrl };
        const url = this._buildUrl(rule.search.url, testVars);
        // 如果搜索 URL 必须带关键词，回退到 baseUrl
        const targetUrl = url.includes('@keyword') ? rule.baseUrl : url;

        try {
            const html = await this._fetch(targetUrl, {
                method: 'GET',
                headers: rule.headers
            });
            const time = Date.now() - start;
            // 简单校验：返回内容长度 > 200 且能解析出 DOM
            const ok = html && html.length > 200;
            this._markSuccess(rule.id, time);
            return {
                success: ok,
                time,
                message: ok ? '连接成功' : '返回内容过短',
                sourceId: rule.id,
                sourceName: rule.name
            };
        } catch (error) {
            const time = Date.now() - start;
            this._markFailure(rule.id, error);
            return {
                success: false,
                time,
                message: error.message || String(error),
                sourceId: rule.id,
                sourceName: rule.name
            };
        }
    }

    // ===== HTTP =====

    async _fetch(url, options = {}) {
        if (!this.httpClient) {
            throw new Error('HttpClient 未注入');
        }
        const headers = Object.assign({}, options.headers || {});
        const fetchOptions = {
            headers,
            charset: 'auto',
            timeout: DEFAULT_TIMEOUT,
            method: String(options.method || 'GET').toUpperCase()
        };
        if (fetchOptions.method === 'POST') {
            fetchOptions.body = new URLSearchParams({ searchword: options.keyword || '' }).toString();
            fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            url = String(url).split('?')[0];
        }
        return this.httpClient.fetch(url, fetchOptions);
    }

    // ===== 健康度 =====

    _markSuccess(sourceId, elapsedMs) {
        const rec = this.health.get(sourceId) || {
            successCount: 0,
            failureCount: 0,
            totalLatency: 0,
            lastSuccessAt: 0,
            lastFailureAt: 0,
            lastError: ''
        };
        rec.successCount++;
        rec.totalLatency += elapsedMs;
        rec.lastSuccessAt = Date.now();
        this.health.set(sourceId, rec);
    }

    _markFailure(sourceId, error) {
        const rec = this.health.get(sourceId) || {
            successCount: 0,
            failureCount: 0,
            totalLatency: 0,
            lastSuccessAt: 0,
            lastFailureAt: 0,
            lastError: ''
        };
        rec.failureCount++;
        rec.lastFailureAt = Date.now();
        rec.lastError = String(error.message || error).slice(0, 240);
        this.health.set(sourceId, rec);
    }

    /**
     * 获取源健康摘要
     */
    getHealth(sourceId) {
        const rec = this.health.get(sourceId);
        if (!rec) {
            return {
                successCount: 0,
                failureCount: 0,
                averageLatency: 0,
                lastSuccessAt: 0,
                lastFailureAt: 0,
                lastError: ''
            };
        }
        return {
            successCount: rec.successCount,
            failureCount: rec.failureCount,
            averageLatency: rec.successCount > 0
                ? Math.round(rec.totalLatency / rec.successCount)
                : 0,
            lastSuccessAt: rec.lastSuccessAt,
            lastFailureAt: rec.lastFailureAt,
            lastError: rec.lastError
        };
    }

    clearHealth(sourceId) {
        if (sourceId) {
            this.health.delete(sourceId);
        } else {
            this.health.clear();
        }
    }
}

module.exports = { SourceRuleEngine };
