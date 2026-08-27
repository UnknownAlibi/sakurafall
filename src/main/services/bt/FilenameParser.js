// 压制组文件名解析器
// 面向 BT 生态的番剧资源命名规范（如 "[VCB-Studio] Fate/stay night [01][Ma10p_1080p][x265_flac].mkv"），
// 提取字幕组、番名、集数、分辨率、编码等结构化信息。
// 纯函数模块，不依赖 Electron 运行时，可直接在 node:test 中测试。

const RESOLUTION_MAP = {
  '2160p': '4K',
  '1080p': '1080P',
  '1080i': '1080P',
  '1036p': '1080P',
  '960p': '960P',
  '864p': '864P',
  '810p': '1080P',
  '816p': '1080P',
  '774p': '774P',
  '720p': '720P',
  '576p': '576P',
  '540p': '540P',
  '480p': '480P'
};

// 从任意文本片段中提取集数（支持 01 / 01v2 / 01.5 / 第01话 / #01 / EP01）
function extractEpisodeFromToken(token) {
  if (!token) return null;
  const text = String(token).trim();
  let m = text.match(/(?:第|EP\.?\s*|EPISODE\s*|#)\s*(\d{1,4})(?:\.\d+)?\s*(?:话|話|集|話|-END)?/i);
  if (m) return Number(m[1]);
  m = text.match(/^(\d{1,4})(?:v\d{1,2})?(?:\.5)?$/i);
  if (m) return Number(m[1]);
  m = text.match(/^(\d{1,4})\s*[-~]\s*(\d{1,4})$/);
  if (m) return Number(m[1]); // 集数区间取起点
  return null;
}

function parseResolution(text) {
  const m = String(text || '').match(/(\d{3,4})[ip]/i);
  if (!m) return null;
  const key = m[1].toLowerCase() + 'p';
  return RESOLUTION_MAP[key] || (m[1] + 'P');
}

function parseVideoCodec(text) {
  // 用环视代替 \b：下划线属于 \w，会导致 [x265_flac] 匹配失败
  const m = String(text || '').match(/(?<![a-z0-9])(x265|h\.?265|hevc|x264|h\.?264|avc|vp9|av1)(?![a-z0-9])/i);
  if (!m) return null;
  const codec = m[1].toLowerCase().replace(/\./g, '');
  if (codec === 'hevc') return 'H.265';
  if (codec === 'h265') return 'H.265';
  if (codec === 'x265') return 'x265';
  if (codec === 'x264') return 'x264';
  if (codec === 'h264') return 'H.264';
  if (codec === 'avc') return 'H.264';
  return codec;
}

function parseAudioCodec(text) {
  const m = String(text || '').match(/(?<![a-z0-9])(aac|flac|ac-?3|eac-?3|dts(?:-hd)?|truehd|opus|mp3|lpcm|pcm)(?![a-z0-9])/i);
  if (!m) return null;
  const codec = m[1].toUpperCase().replace(/-/, '');
  if (codec === 'AC3') return 'AC3';
  if (codec === 'EAC3') return 'EAC3';
  return codec;
}

function parseBitDepth(text) {
  const m = String(text || '').match(/(?<![a-z0-9])(8|10|12)[-_ ]?bit(?![a-z0-9])|(?<![a-z0-9])(hi10p|hi444pp|ma10p)(?![a-z0-9])/i);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  return 10;
}

// 特殊条目标记：NCOP/NCED/SP/OVA/MENU/PV 等
function parseSpecialKind(text) {
  const m = String(text || '').match(/(?<![a-z0-9])(NCOP|NCED|OP|ED|SP|OVA|OAD|PV|CM|MENU|PREVIEW|KIRAKIRA)(?![a-z0-9])/i);
  if (!m) return null;
  const kind = m[1].toUpperCase();
  return ['NCOP', 'NCED', 'OP', 'ED', 'SP', 'OVA', 'OAD', 'PV', 'CM', 'MENU', 'PREVIEW', 'KIRAKIRA'].includes(kind) ? kind : null;
}

function parseSeason(text) {
  const m = String(text || '').match(/(?<![a-z0-9])S(\d{1,2})(?![a-z0-9])|第\s*([一二三四五六七八九十\d]{1,3})\s*季|Season\s*(\d{1,2})/i);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  if (m[3]) return Number(m[3]);
  const cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const raw = m[2];
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.length === 2 && raw[0] === '十') return 10 + (cn[raw[1]] || 0);
  if (raw === '十') return 10;
  return cn[raw[0]] || null;
}

/**
 * 解析压制组资源文件名
 * @param {string} filename - 文件名（可含扩展名），也兼容资源站标题
 * @returns {{
 *   raw: string, group: string|null, title: string|null, episode: number|null,
 *   season: number|null, resolution: string|null, videoCodec: string|null,
 *   audioCodec: string|null, bitDepth: number|null, special: string|null,
 *   isComplete: boolean, isUncensored: boolean, subtitleLang: string|null
 * }}
 */
function parseAnimeFilename(filename) {
  const raw = String(filename || '').trim();
  const result = {
    raw,
    group: null,
    title: null,
    episode: null,
    season: null,
    resolution: null,
    videoCodec: null,
    audioCodec: null,
    bitDepth: null,
    special: null,
    isComplete: false,
    isUncensored: false,
    subtitleLang: null
  };
  if (!raw) return result;

  // 去掉扩展名与常见站点前缀
  let text = raw.replace(/\.(mkv|mp4|avi|ts|mov|wmv|flv|webm)$/i, '');
  text = text.replace(/^\[[^\]]{0,20}\]\s*/, (m) => (/bt|种子|磁力/i.test(m) ? '' : m));

  // 字幕组：第一个 [..] 或（..）块
  const groupMatch = text.match(/^[[(]([^\])]{1,30})[\])]/);
  if (groupMatch && /[-_&·\w]{1,30}/.test(groupMatch[1])) {
    result.group = groupMatch[1].trim();
    text = text.slice(groupMatch[0].length).trim();
  }

  // 全局属性（在整个文件名里找，不限于剩余部分）
  const whole = raw;
  result.resolution = parseResolution(whole);
  result.videoCodec = parseVideoCodec(whole);
  result.audioCodec = parseAudioCodec(whole);
  result.bitDepth = parseBitDepth(whole);
  result.season = parseSeason(whole);
  result.special = parseSpecialKind(whole);
  result.isComplete = /完结|全集|FIN|END(?![a-z])|Complete/i.test(whole) && !/\[\d+\]/.test(whole);
  result.isUncensored = /无修正|无码|UNCENSORED/i.test(whole);
  const subMatch = whole.match(/(?<![a-z0-9])(CHT|CHS|GB|BIG5|简体|繁體|繁体|简日|繁日|双语|简繁)(?![a-z0-9])/i);
  if (subMatch) {
    const s = subMatch[1].toUpperCase();
    result.subtitleLang = s.includes('CHT') || s.includes('BIG5') || s.includes('繁') ? '繁中'
      : (s.includes('CHS') || s.includes('GB') || s.includes('简') ? '简中' : '双语');
  }

  // 集数：优先从 [数字] 块取（压制组规范），其次 " - 01" / " 01 "
  const bracketEps = [...text.matchAll(/\[(\d{1,4}(?:v\d{1,2})?(?:\.5)?)\]/gi)];
  if (bracketEps.length > 0) {
    // 多个 [数字] 块时，取第一个像集数的（排除分辨率如 [1080]、码率如 [1920x1080]）
    for (const m of bracketEps) {
      const value = m[1];
      if (/^(\d{1,3})(v\d+)?(\.5)?$/i.test(value)) {
        const ep = extractEpisodeFromToken(value);
        if (ep != null && ep >= 0 && ep <= 999) { result.episode = ep; break; }
      }
    }
    if (result.episode == null) {
      const ep = extractEpisodeFromToken(bracketEps[0][1]);
      if (ep != null && ep <= 999) result.episode = ep;
    }
  }

  if (result.episode == null) {
    const epPatterns = [
      /[-\s]\s*(\d{1,4})(?:v\d+)?\s*(?:\[|\(|$)/i,
      /#\s*(\d{1,4})/,
      /第\s*(\d{1,4})\s*[话話集]/
    ];
    for (const pattern of epPatterns) {
      const m = text.match(pattern);
      const value = m ? Number(m[1]) : null;
      if (value != null && value >= 0 && value <= 999) { result.episode = value; break; }
    }
  }

  // 番名：集数标记之前的文本，取所有截断标记中最早出现的位置
  let titleText = text;
  const cutMarkers = [
    /\s*[-–—]\s*\[?\d{1,4}/,       // " - 01"
    /\s+\[\d{1,4}/,                 // " [01]"
    /\s*第\s*\d+\s*[话話集]/,        // "第01话"
    /#\s*\d{1,4}/                   // "#01"
  ];
  let cutIndex = -1;
  for (const marker of [...cutMarkers, /\s+\d{1,3}(?:v\d+)?\s*(?:\[|\(|$)/]) {
    const idx = titleText.search(marker);
    if (idx > 0 && (cutIndex === -1 || idx < cutIndex)) cutIndex = idx;
  }
  if (cutIndex > 0) titleText = titleText.slice(0, cutIndex);

  titleText = titleText
    .replace(/\[(?:[^\]]{0,24})\]/g, (block) => (/^\[\d{1,4}(v\d+)?(\.5)?\]$/i.test(block) ? '' : ' '))
    .replace(/（[^）]{0,24}）/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—_]+|[\s\-–—_]+$/g, '')
    .trim();

  // 保留含"/"的原名（如 Fate/stay night），过滤纯属性残余
  if (titleText && titleText.length >= 1 && !/^\d+$/.test(titleText)) {
    result.title = titleText;
  }

  // 标题兜底：若番名被吃掉（全是属性块），用第一段非属性文本
  if (!result.title && result.group) {
    const fallback = text.split(/\s{2,}|\]|\[|\s-\s/).map(s => s.trim())
      .find(s => s && !/^\d+(v\d+)?$/.test(s) && !RESOLUTION_MAP[s.toLowerCase()] && s.length >= 2 && !/[\d]{3,4}[ip]/i.test(s));
    if (fallback) result.title = fallback;
  }

  return result;
}

module.exports = {
  parseAnimeFilename,
  parseResolution,
  parseVideoCodec,
  parseAudioCodec,
  extractEpisodeFromToken
};
