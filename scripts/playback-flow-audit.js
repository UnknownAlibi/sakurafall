// 播放解析全流程审计脚本
// 遍历 多个源 × 多部动漫，跑完整 搜索→详情→集数解析→预检探测 流程
// 目的：暴露"源站返回错误状态码"等问题的真实分布
//
// 用法: node scripts/playback-flow-audit.js [--proxy http://127.0.0.1:7890] [--animes 5] [--sources all]
//   --proxy    代理地址（测试源站需要代理时使用）
//   --animes   每个源测试的动漫数量（默认 5）
//   --sources  测试的源 id 列表，逗号分隔，默认 all

const path = require('path');
const fs = require('fs');
const HttpClient = require('../src/main/utils/HttpClient');
const { parseEpisodes } = require('../src/main/services/cms/EpisodeParser');

// ===== 参数解析 =====
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return def;
}
const PROXY = getArg('proxy', '');
const ANIMES_PER_SOURCE = parseInt(getArg('animes', '5'), 10);
const SOURCE_FILTER = getArg('sources', 'all');

// ===== 测试用动漫（热门，确保多数源都有）=====
const TEST_ANIMES = [
  '鬼灭之刃',
  '咒术回战',
  '间谍过家家',
  '葬送的芙莉莲',
  '我推的孩子',
  '药师少女的独语',
  '电锯人',
  '国王排名',
  '进击的巨人',
  '辉夜大小姐想让我告白'
].slice(0, ANIMES_PER_SOURCE);

// ===== 加载源配置 =====
function loadSources() {
  const packPath = path.join(__dirname, '..', 'extensions', 'bundled', 'sources', 'sakurafall-default.sourcepack.json');
  const raw = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  let sources = raw?.content?.cmsSources || [];
  if (SOURCE_FILTER !== 'all') {
    const ids = SOURCE_FILTER.split(',').map(s => s.trim()).filter(Boolean);
    sources = sources.filter(s => ids.includes(s.id));
  }
  return sources;
}

// ===== HTTP 客户端（带可选代理）=====
const http = new HttpClient({
  timeout: 15000,
  headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' }
});
if (PROXY) http.setProxy(PROXY);

const probeHttp = new HttpClient({
  timeout: 8000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
});
if (PROXY) probeHttp.setProxy(PROXY);

// ===== 工具函数 =====
function normalizeUrl(url) {
  const v = String(url || '').trim();
  if (!v) return '';
  const n = v.startsWith('//') ? `https:${v}` : v;
  try { return new URL(n).toString(); } catch (_) { return n; }
}

function isDirectMediaUrl(url) {
  const n = normalizeUrl(url);
  try {
    const p = new URL(n);
    if (p.protocol === 'blob:' || p.protocol === 'data:' || p.protocol === 'file:') return true;
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
    return /\.(?:m3u8|mp4|m4v|webm|ogv|ogg)(?:[?#]|$)|\/hls(?:[/?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$)/i.test(n);
  } catch (_) { return false; }
}

function isSharePageUrl(url) {
  return normalizeUrl(url).includes('/share/');
}

function guessQualityFromUrl(url) {
  const u = normalizeUrl(url).toLowerCase();
  if (u.includes('2160') || u.includes('4k')) return '4K';
  if (u.includes('1080')) return '1080P';
  if (u.includes('720')) return '720P';
  if (u.includes('480')) return '480P';
  return '';
}

// 复刻 _classifyError 的分类逻辑
function classifyError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('403') || message.includes('forbidden')) return 'cors-referer(403)';
  if (message.includes('resolver_timeout') || message.includes('timeout') || message.includes('etimedout')) return 'resolver-timeout';
  if (message.includes('enotfound') || message.includes('econnrefused') || message.includes('eai_again')) return 'dns-failed';
  if (message.includes('invalid_m3u8_manifest')) return 'invalid-m3u8';
  if (message.includes('unsupported_direct_media_url')) return 'format-unsupported';
  if (/\b[45]\d\d\b/.test(message) || message.includes('status code')) return 'network-blocked(4xx/5xx)';
  return 'unknown';
}

// ===== 单源单动漫测试 =====
async function searchAnime(source, keyword) {
  const apiUrl = `${source.api}?ac=detail&wd=${encodeURIComponent(keyword)}&pg=1`;
  const text = await http.fetch(apiUrl, { referer: source.api, timeout: 12000 });
  const data = JSON.parse(text);
  const list = Array.isArray(data?.list) ? data.list : [];
  if (list.length === 0) return null;
  // 取第一个有 vod_play_url 的
  return list.find(v => v.vod_play_url) || list[0] || null;
}

function pickFirstEpisode(vod) {
  if (!vod?.vod_play_url) return null;
  const lines = parseEpisodes(vod.vod_play_from, vod.vod_play_url);
  const lineKeys = Object.keys(lines);
  if (lineKeys.length === 0) return null;
  const eps = lines[lineKeys[0]];
  if (!eps || eps.length === 0) return null;
  return eps[0]; // { id, title, url, play_url }
}

// 复刻 probeStreamQuality + _validateVideoUrl 的核心逻辑
async function probePlayUrl(playUrl, sourceId) {
  const normalized = normalizeUrl(playUrl);
  if (!normalized) return { status: 'invalid-url', error: '空地址' };

  // 步骤1: isDirectMediaUrl 检查
  if (!isDirectMediaUrl(normalized)) {
    if (isSharePageUrl(normalized)) {
      return { status: 'share-page', urlType: '分享页', error: '需要分享页解析器' };
    }
    return { status: 'webpage', urlType: '网页', error: 'UNSUPPORTED_DIRECT_MEDIA_URL' };
  }

  // 步骤2: 非 m3u8 直链（如 mp4）不探测，直接判定可播放
  if (!/^https?:\/\//i.test(normalized) || !/\.m3u8(?:[?#]|$)|\/hls(?:[/?#]|$)/i.test(normalized)) {
    return { status: 'playable-mp4', urlType: 'mp4直链', quality: guessQualityFromUrl(normalized) };
  }

  // 步骤3: m3u8 预检探测（复刻 probeStreamQuality）
  const probeStart = Date.now();
  try {
    const text = await probeHttp.fetch(normalized, {
      referer: normalized,
      timeout: 5000,
      headers: { 'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' }
    });
    if (!String(text || '').trimStart().startsWith('#EXTM3U')) {
      return {
        status: 'probe-failed',
        urlType: 'm3u8',
        error: 'INVALID_M3U8_MANIFEST: 返回的不是 m3u8 清单',
        elapsedMs: Date.now() - probeStart,
        // 关键标记：预检失败但视频可能可播
        wouldBlockPlayback: true
      };
    }
    return {
      status: 'ok',
      urlType: 'm3u8',
      quality: guessQualityFromUrl(normalized),
      elapsedMs: Date.now() - probeStart
    };
  } catch (error) {
    return {
      status: 'probe-failed',
      urlType: 'm3u8',
      error: error.message,
      errorCode: error.code,
      statusCode: error.statusCode,
      category: classifyError(error),
      elapsedMs: Date.now() - probeStart,
      // 关键标记：预检失败但视频可能可播
      wouldBlockPlayback: true
    };
  }
}

// ===== 单源测试 =====
async function testSource(source) {
  const results = [];
  for (const keyword of TEST_ANIMES) {
    const item = { source: source.id, sourceName: source.name, keyword, status: 'pending' };
    try {
      const vod = await searchAnime(source, keyword);
      if (!vod) {
        item.status = 'no-result';
        item.error = '搜索无结果';
        results.push(item);
        continue;
      }
      item.animeName = vod.vod_name || '';
      const ep = pickFirstEpisode(vod);
      if (!ep) {
        item.status = 'no-episode';
        item.error = '无可播放集数';
        results.push(item);
        continue;
      }
      item.episodeTitle = ep.title;
      item.playUrl = ep.url;

      const probe = await probePlayUrl(ep.url, source.id);
      Object.assign(item, probe);
      item.status = probe.status;
    } catch (error) {
      item.status = 'search-failed';
      item.error = error.message;
      item.category = classifyError(error);
    }
    results.push(item);
    // 打印单条结果
    const tag = item.wouldBlockPlayback ? '⚠️阻断' : '';
    console.log(`  [${source.name}] ${keyword.padEnd(8)} → ${item.status.padEnd(14)} ${tag} ${item.error || ''}`);
  }
  return results;
}

// ===== 主流程 =====
(async () => {
  const sources = loadSources();
  console.log('===== 播放解析全流程审计 =====');
  console.log(`源数量: ${sources.length} | 每源测试动漫: ${TEST_ANIMES.length} | 代理: ${PROXY || '无'}`);
  console.log(`测试动漫: ${TEST_ANIMES.join(', ')}`);
  console.log('');

  // 源之间并行（每个源内部串行，避免单源限流）
  const allResults = [];
  const sourceResults = await Promise.all(sources.map(s => testSource(s).catch(e => {
    console.error(`[源 ${s.id}] 测试崩溃:`, e.message);
    return [];
  })));
  for (const r of sourceResults) allResults.push(...r);

  // ===== 统计 =====
  console.log('\n===== 统计汇总 =====');
  const total = allResults.length;
  const byStatus = {};
  const bySource = {};
  let blockedCount = 0;

  for (const r of allResults) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (!bySource[r.source]) bySource[r.source] = { name: r.sourceName, total: 0, ok: 0, blocked: 0, failed: 0 };
    bySource[r.source].total++;
    if (r.status === 'ok' || r.status === 'playable-mp4') bySource[r.source].ok++;
    if (r.wouldBlockPlayback) { bySource[r.source].blocked++; blockedCount++; }
    if (r.status !== 'ok' && r.status !== 'playable-mp4' && r.status !== 'share-page') bySource[r.source].failed++;
  }

  console.log(`\n总样本: ${total}`);
  console.log(`预检阻断(可播放但被预检拦截): ${blockedCount} (${(blockedCount/total*100).toFixed(1)}%)`);
  console.log('\n--- 按状态分布 ---');
  for (const [status, count] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(20)} ${count} (${(count/total*100).toFixed(1)}%)`);
  }

  console.log('\n--- 按源分布 ---');
  console.log('  源ID            源名       总数  可播  阻断  失败');
  for (const s of sources) {
    const s2 = bySource[s.id];
    if (!s2) continue;
    console.log(`  ${s.id.padEnd(16)} ${s.name.padEnd(8)} ${String(s2.total).padStart(4)} ${String(s2.ok).padStart(4)} ${String(s2.blocked).padStart(4)} ${String(s2.failed).padStart(4)}`);
  }

  // 输出阻断样本详情
  const blockedSamples = allResults.filter(r => r.wouldBlockPlayback);
  if (blockedSamples.length > 0) {
    console.log('\n--- 预检阻断样本（这些会被判定为"不可播放"但视频可能可播）---');
    for (const r of blockedSamples.slice(0, 15)) {
      console.log(`  [${r.sourceName}] ${r.keyword} | ${r.urlType} | ${r.error} | ${r.category || ''}`);
    }
    if (blockedSamples.length > 15) console.log(`  ... 还有 ${blockedSamples.length - 15} 条`);
  }

  // 保存详细结果到文件
  const reportPath = path.join(__dirname, 'playback-audit-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    proxy: PROXY || 'none',
    animesPerSource: TEST_ANIMES.length,
    summary: { total, blockedCount, byStatus, bySource },
    samples: allResults
  }, null, 2), 'utf8');
  console.log(`\n详细报告已保存: ${reportPath}`);
})();
