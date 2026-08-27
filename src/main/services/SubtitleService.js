/**
 * 字幕服务
 *
 * 功能：
 *   1. 解析本地字幕文件（SRT / VTT / ASS / SSA）
 *   2. 自动检测文件编码（UTF-8 / GBK）
 *   3. 在线搜索字幕（OpenSubtitles，需要用户配置 API Key）
 *
 * 统一字幕 cue 对象格式：
 *   { start: 秒, end: 秒, text: '文本（可含 \\n 多行）' }
 */

const fs = require('fs');
const path = require('path');
const HttpClient = require('../utils/HttpClient');

// ============================================================
// 时间格式转换
// ============================================================

/**
 * 把 SRT/ASS 时间戳转换为秒
 * 支持：
 *   - hh:mm:ss,ms   (SRT: 00:00:01,000)
 *   - hh:mm:ss.ms   (VTT/ASS: 00:00:01.000)
 *   - mm:ss,ms / mm:ss.ms
 * @param {string} timestamp
 * @returns {number} 秒（浮点）
 */
function timeToSeconds(timestamp) {
    if (typeof timestamp !== 'string') return 0;
    // 统一将 , 替换为 .，便于后续解析
    const normalized = timestamp.trim().replace(',', '.');
    const parts = normalized.split(':');
    let hours = 0, minutes = 0, seconds = 0;
    if (parts.length === 3) {
        hours = parseInt(parts[0], 10) || 0;
        minutes = parseInt(parts[1], 10) || 0;
        seconds = parseFloat(parts[2]) || 0;
    } else if (parts.length === 2) {
        minutes = parseInt(parts[0], 10) || 0;
        seconds = parseFloat(parts[1]) || 0;
    } else if (parts.length === 1) {
        seconds = parseFloat(parts[0]) || 0;
    }
    return hours * 3600 + minutes * 60 + seconds;
}

// ============================================================
// SRT 解析
// ============================================================

/**
 * 解析 SRT 字幕内容
 * 格式：
 *   1
 *   00:00:01,000 --> 00:00:03,000
 *   字幕文本（可多行）
 *
 *   2
 *   ...
 * @param {string} content
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function parseSrt(content) {
    if (!content) return [];
    // 规范化换行符
    const text = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 去除 BOM
    const cleaned = text.replace(/^\uFEFF/, '');
    // 按空行分段
    const blocks = cleaned.split(/\n\s*\n/);
    const cues = [];
    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) continue;
        // 找到时间行（含 -->）
        let timeLineIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timeLineIdx = i;
                break;
            }
        }
        if (timeLineIdx === -1) continue;
        const timeLine = lines[timeLineIdx];
        const match = timeLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
        if (!match) continue;
        const start = timeToSeconds(match[1]);
        const end = timeToSeconds(match[2]);
        // 时间行之后的所有行视为字幕文本
        const textLines = lines.slice(timeLineIdx + 1);
        const cueText = textLines.join('\n').trim();
        if (!cueText) continue;
        cues.push({ start, end, text: cueText });
    }
    return cues;
}

// ============================================================
// VTT (WebVTT) 解析
// ============================================================

/**
 * 解析 WebVTT 字幕内容
 * 与 SRT 类似，但：
 *   - 文件头为 WEBVTT
 *   - 时间格式用 . 而非 ,
 *   - 可能有 NOTE / STYLE / REGION 等块
 *   - cue 行可能带样式标签如 <c.classname>、<i>、<b>
 * @param {string} content
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function parseVtt(content) {
    if (!content) return [];
    const text = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
    // 移除 WEBVTT 头部及元数据
    const blocks = text.split(/\n\s*\n/);
    const cues = [];
    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) continue;
        // 跳过 WEBVTT 头部
        if (lines[0].startsWith('WEBVTT')) continue;
        // 跳过 NOTE / STYLE / REGION 块
        if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
        // 找到时间行
        let timeLineIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timeLineIdx = i;
                break;
            }
        }
        if (timeLineIdx === -1) continue;
        const timeLine = lines[timeLineIdx];
        // VTT 时间行格式：00:00:01.000 --> 00:00:03.000 [align=right] [position:50%]
        const match = timeLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
        if (!match) continue;
        const start = timeToSeconds(match[1]);
        const end = timeToSeconds(match[2]);
        const textLines = lines.slice(timeLineIdx + 1);
        // 移除 VTT 标签：<c.xxx>、</c>、<i>、</i>、<b>、</b>、<u>、</u>
        const cueText = textLines.join('\n')
            .replace(/<\/?c[^>]*>/g, '')
            .replace(/<\/?[iub]>/g, '')
            .replace(/<\d+:\d+:\d+\.\d+>/g, '') // 移除内嵌时间标签
            .trim();
        if (!cueText) continue;
        cues.push({ start, end, text: cueText });
    }
    return cues;
}

// ============================================================
// ASS / SSA 解析（简化版）
// ============================================================

/**
 * 解析 ASS / SSA 字幕内容（简化版）
 * 只提取 [Events] 段的 Dialogue 行，解析时间和文本
 * Dialogue 格式：
 *   Dialogue: 0,0:00:01:00,0:00:03:00,Default,,0,0,0,,字幕文本
 *
 * Format 行决定字段顺序，常见默认：
 *   Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
 * @param {string} content
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function parseAss(content) {
    if (!content) return [];
    const text = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
    const lines = text.split('\n');

    // 先解析 [Events] 段的 Format 行
    let inEvents = false;
    let formatFields = null;
    const cues = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            inEvents = trimmed.toLowerCase() === '[events]';
            continue;
        }
        if (!inEvents) continue;

        // 解析 Format 行
        if (/^Format\s*:/i.test(trimmed)) {
            const fmt = trimmed.replace(/^Format\s*:\s*/i, '');
            formatFields = fmt.split(',').map(s => s.trim().toLowerCase());
            continue;
        }

        // 解析 Dialogue 行
        if (/^Dialogue\s*:/i.test(trimmed)) {
            const rest = trimmed.replace(/^Dialogue\s*:\s*/i, '');
            if (!formatFields) {
                // 没有 Format 行时使用默认字段顺序
                formatFields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
            }
            const textIdx = formatFields.indexOf('text');
            const startIdx = formatFields.indexOf('start');
            const endIdx = formatFields.indexOf('end');
            if (textIdx === -1 || startIdx === -1 || endIdx === -1) continue;

            // 关键：Text 字段可能包含逗号，所以前 N-1 个字段用 split 限制次数
            // split 数量 = textIdx + 1，最后一个元素就是 Text 全部内容
            const parts = rest.split(',', textIdx + 1);
            if (parts.length < textIdx + 1) continue;

            const start = timeToSeconds(parts[startIdx]);
            const end = timeToSeconds(parts[endIdx]);
            let cueText = parts[textIdx].trim();

            // 移除 ASS 覆盖标签 {\xxx}
            cueText = cueText.replace(/\{[^}]*\}/g, '');
            // \N 表示硬换行，\n 表示软换行
            cueText = cueText.replace(/\\N/g, '\n').replace(/\\n/g, '\n').trim();
            if (!cueText) continue;
            cues.push({ start, end, text: cueText });
        }
    }
    return cues;
}

// ============================================================
// 自动格式识别 + 编码检测
// ============================================================

/**
 * 根据内容和文件扩展名自动选择解析器
 * @param {string} content - 字幕内容字符串
 * @param {string} [filePath] - 文件路径（用于辅助判断扩展名）
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function parseAuto(content, filePath) {
    if (!content) return [];
    const ext = filePath ? path.extname(filePath).toLowerCase() : '';
    const header = String(content).slice(0, 50).toUpperCase();

    // 优先用扩展名判断
    if (ext === '.srt') return parseSrt(content);
    if (ext === '.vtt') return parseVtt(content);
    if (ext === '.ass' || ext === '.ssa') return parseAss(content);

    // 无扩展名时按内容判断
    if (header.includes('WEBVTT')) return parseVtt(content);
    if (/\[SCRIPT INFO\]/i.test(content) || /\[V4\+?\s*STYLES\]/i.test(content) || /\[EVENTS\]/i.test(content)) {
        return parseAss(content);
    }
    // 默认按 SRT 解析
    return parseSrt(content);
}

/**
 * 检测 Buffer 编码（UTF-8 / GBK），返回解码后的字符串
 * 简易实现：先尝试 UTF-8，失败则回退 GBK
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) return String(buffer || '');

    // 检测 BOM
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return buffer.slice(3).toString('utf8');
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.slice(2).toString('utf16le');
    }

    // 尝试 UTF-8 严格解码
    try {
        const text = buffer.toString('utf8');
        // 简单的 UTF-8 校验：检查是否有替换字符 U+FFFD，或常见的 GBK 误判特征
        // GBK 中文字节高位为 0x81-0xFE，第二个字节 0x40-0xFE
        // 如果 UTF-8 解码后出现连续的替换字符，说明可能不是 UTF-8
        if (!/[\uFFFD]/.test(text)) {
            return text;
        }
        // 进一步校验：尝试用 GBK 解码看是否更合理
        // 检查 buffer 中是否有 0x80 以上的字节且 UTF-8 解码出现替换字符
        const hasHighBytes = buffer.some(b => b > 0x7f);
        if (!hasHighBytes) return text; // 纯 ASCII，直接返回
    } catch (e) {
        // 继续尝试 GBK
    }

    // 回退到 GBK
    try {
        // Node.js 原生支持 'gbk' 需 ICU 全量构建，部分环境可能不支持
        // 使用 'gb18030' 兼容性更好（gb18030 是 GBK 超集）
        const gbkText = buffer.toString('gb18030');
        return gbkText;
    } catch (e) {
        // 最终回退：直接 utf8
        return buffer.toString('utf8');
    }
}

/**
 * 读取字幕文件并自动检测编码
 * @param {string} filePath - 字幕文件绝对路径
 * @returns {Promise<{content: string, cues: Array, format: string}>}
 */
async function parseFile(filePath) {
    if (!filePath) throw new Error('字幕文件路径为空');
    if (!fs.existsSync(filePath)) throw new Error('字幕文件不存在: ' + filePath);

    const buffer = await fs.promises.readFile(filePath);
    const content = decodeBuffer(buffer);
    const ext = path.extname(filePath).toLowerCase();
    let format = 'srt';
    let cues;
    if (ext === '.vtt' || /^WEBVTT/i.test(content.trim())) {
        format = 'vtt';
        cues = parseVtt(content);
    } else if (ext === '.ass' || ext === '.ssa' || /\[SCRIPT INFO\]/i.test(content)) {
        format = 'ass';
        cues = parseAss(content);
    } else {
        cues = parseSrt(content);
    }
    return { content, cues, format };
}

// ============================================================
// OpenSubtitles 在线搜索（可选）
// ============================================================

/**
 * OpenSubtitles REST API（v1）
 * 文档：https://opensubtitles.stoplight.io/
 * 需要 Api-Key（用户在 opensubtitles.com 注册后可在开发者页面获取）
 */
const OPENSUBTITLES_API = 'https://api.opensubtitles.com/api/v1';

class SubtitleService {
    constructor() {
        this.apiKey = '';
        this.timeout = 15000;
        this.http = new HttpClient({
            timeout: this.timeout,
            headers: {
                'User-Agent': 'SakuraFall Anime Downloader v1.0',
                'Accept': 'application/json'
            }
        });
    }

    setTimeout(timeout) {
        this.timeout = Math.max(5000, parseInt(timeout, 10) || 15000);
        this.http.setTimeout(this.timeout);
    }

    setProxy(proxyUrl) { this.http.setProxy(proxyUrl); }

    /**
     * 设置 OpenSubtitles API Key
     * @param {string} apiKey
     */
    setApiKey(apiKey) {
        this.apiKey = (apiKey || '').trim();
    }

    /**
     * 是否已配置 OpenSubtitles API Key
     */
    isReady() {
        return !!this.apiKey;
    }

    /**
     * 在线搜索字幕
     * @param {string} keyword - 搜索关键词（番剧名/电影名）
     * @param {string} [language='zh'] - 语言代码（zh / en / ja 等）
     * @returns {Promise<Array>} 字幕条目列表
     *   每项: { id, language, title, releaseName, url, rating, downloadCount, fromEpisode }
     */
    async searchOnline(keyword, language = 'zh') {
        if (!this.isReady()) {
            throw new Error('未配置 OpenSubtitles API Key，请在设置中填写');
        }
        if (!keyword) throw new Error('搜索关键词为空');

        const query = encodeURIComponent(keyword.trim());
        const lang = encodeURIComponent(language || 'zh');
        const url = `${OPENSUBTITLES_API}/subtitles?query=${query}&languages=${lang}`;

        const text = await this.http.fetch(url, {
            headers: {
                'Api-Key': this.apiKey,
                'Content-Type': 'application/json'
            }
        });

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('OpenSubtitles 返回数据解析失败: ' + e.message);
        }

        if (!data || !Array.isArray(data.data)) return [];

        // 映射为统一格式
        return data.data.map(item => {
            const attrs = item.attributes || {};
            const files = Array.isArray(attrs.files) ? attrs.files : [];
            const firstFile = files[0] || {};
            return {
                id: item.id || '',
                language: attrs.language || '',
                title: attrs.release || attrs.title || '',
                releaseName: attrs.release || '',
                url: firstFile.file_id ? `${OPENSUBTITLES_API}/download?file_id=${firstFile.file_id}` : '',
                fileId: firstFile.file_id || null,
                rating: attrs.ratings || 0,
                downloadCount: attrs.download_count || 0,
                fromEpisode: attrs.feature_details?.episode_number || null,
                fromSeason: attrs.feature_details?.season_number || null
            };
        }).filter(item => item.url || item.fileId);
    }

    /**
     * 下载字幕文件内容（通过 file_id）
     * OpenSubtitles 的 /download 端点返回带链接的 JSON，需二次请求获取实际文件
     * @param {number} fileId
     * @returns {Promise<string>} 字幕文件内容
     */
    async downloadSubtitle(fileId) {
        if (!this.isReady()) {
            throw new Error('未配置 OpenSubtitles API Key');
        }
        if (!fileId) throw new Error('fileId 为空');

        // 第一步：请求 /download 获取下载链接
        const downloadUrl = `${OPENSUBTITLES_API}/download`;
        const text = await this.http.fetch(downloadUrl, {
            method: 'POST',
            headers: {
                'Api-Key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ file_id: fileId })
        });

        let downloadInfo;
        try {
            downloadInfo = JSON.parse(text);
        } catch (e) {
            throw new Error('解析下载链接失败: ' + e.message);
        }

        const link = downloadInfo.link || downloadInfo.file_name;
        if (!link) throw new Error('未获取到下载链接');

        // 第二步：下载实际文件内容
        const fileText = await this.http.fetch(link, {
            headers: { 'Api-Key': this.apiKey }
        });
        return fileText;
    }
}

// 导出单例 + 静态方法
const subtitleService = new SubtitleService();

module.exports = subtitleService;
module.exports.SubtitleService = SubtitleService;
module.exports.parseSrt = parseSrt;
module.exports.parseVtt = parseVtt;
module.exports.parseAss = parseAss;
module.exports.parseAuto = parseAuto;
module.exports.parseFile = parseFile;
module.exports.timeToSeconds = timeToSeconds;
module.exports.decodeBuffer = decodeBuffer;
