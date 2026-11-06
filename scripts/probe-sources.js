#!/usr/bin/env node
/**
 * 片源体检：探测本地源包里的 CMS 接口与 XPath 站点是否还活着。
 *
 * 用法：
 *   node scripts/probe-sources.js                 # 只读探测，打印报告
 *   node scripts/probe-sources.js --json          # 输出 JSON（便于脚本处理）
 *   node scripts/probe-sources.js --concurrency 6 # 调整并发（默认 4）
 *   node scripts/probe-sources.js --timeout 20000 # 单请求超时（默认 15s）
 *
 * 判定标准：
 *   CMS  → GET {api}?ac=list 返回 JSON 且 code=1、list 为数组，且存在动漫分类
 *   XPath→ 站点首页可访问（2xx/3xx）
 * 不修改任何文件，只输出结论，人工确认后再动源包。
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.resolve(__dirname, '..', 'extensions', 'bundled', 'sources');
const PACK_FILES = ['sakurafall-default.sourcepack.json', 'xpath-community.sourcepack.json'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) || fallback : fallback;
};
const asJson = flag('json');
const concurrency = Math.max(1, option('concurrency', 4));
const timeoutMs = Math.max(3000, option('timeout', 15000));

function readPacks() {
  const packs = [];
  for (const file of PACK_FILES) {
    const full = path.join(SOURCE_DIR, file);
    if (!fs.existsSync(full)) continue;
    try {
      packs.push({ file, pack: JSON.parse(fs.readFileSync(full, 'utf8')) });
    } catch (error) {
      packs.push({ file, error: error.message });
    }
  }
  return packs;
}

async function probeCms(source) {
  const started = Date.now();
  try {
    const res = await fetch(`${source.api}?ac=list`, {
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    const ms = Date.now() - started;
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 返回 HTML 说明接口已失效 */ }
    const ok = res.status === 200 && json && Number(json.code) === 1 && Array.isArray(json.list);
    const classes = Array.isArray(json?.class) ? json.class : [];
    const anime = classes.filter(item => /动漫|动画/.test(String(item.type_name || '')));
    return {
      kind: 'cms',
      id: source.id,
      name: source.name,
      endpoint: source.api,
      status: ok ? 'ok' : 'dead',
      httpStatus: res.status,
      elapsedMs: ms,
      total: Number(json?.total) || 0,
      animeCategories: anime.map(item => `${item.type_id}:${item.type_name}`),
      note: ok ? '' : (json ? `code=${json.code}` : `non-json: ${text.slice(0, 60).replace(/\s+/g, ' ')}`)
    };
  } catch (error) {
    return {
      kind: 'cms',
      id: source.id,
      name: source.name,
      endpoint: source.api,
      status: 'unreachable',
      elapsedMs: Date.now() - started,
      note: error.cause?.code || error.message
    };
  }
}

async function probeXpath(rule) {
  const started = Date.now();
  try {
    const res = await fetch(rule.baseUrl, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {
      kind: 'xpath',
      id: rule.id,
      name: rule.name,
      endpoint: rule.baseUrl,
      status: res.ok ? 'ok' : 'dead',
      httpStatus: res.status,
      elapsedMs: Date.now() - started,
      enabled: rule.enabled !== false,
      note: res.ok ? '' : `HTTP ${res.status}`
    };
  } catch (error) {
    return {
      kind: 'xpath',
      id: rule.id,
      name: rule.name,
      endpoint: rule.baseUrl,
      status: 'unreachable',
      elapsedMs: Date.now() - started,
      enabled: rule.enabled !== false,
      note: error.cause?.code || error.message
    };
  }
}

async function runPool(tasks) {
  const results = [];
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      results.push(await task());
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  const packs = readPacks();
  if (packs.length === 0) {
    console.error(`未找到源包目录：${SOURCE_DIR}`);
    process.exit(1);
  }

  const tasks = [];
  for (const { pack, file, error } of packs) {
    if (error) {
      console.error(`[跳过] ${file} 解析失败：${error}`);
      continue;
    }
    for (const source of pack.content?.cmsSources || []) {
      tasks.push(() => probeCms(source));
    }
    for (const rule of pack.content?.xpathRules || []) {
      tasks.push(() => probeXpath(rule));
    }
  }

  const results = (await runPool(tasks)).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ok' ? -1 : 1;
    return a.elapsedMs - b.elapsedMs;
  });
  const ok = results.filter(item => item.status === 'ok');
  const bad = results.filter(item => item.status !== 'ok');

  if (asJson) {
    console.log(JSON.stringify({ ok, bad, generatedAt: new Date().toISOString() }, null, 2));
    process.exit(0);
  }

  const pad = (value, width) => String(value ?? '').padEnd(width).slice(0, width);
  console.log(`\n可用 ${ok.length} 个：`);
  for (const item of ok) {
    const cats = item.kind === 'cms' ? `动漫分类 ${item.animeCategories.length} 个` : `XPath${item.enabled ? '' : '（已禁用）'}`;
    console.log(`  ${pad(item.status, 2)} ${pad(item.id, 12)} ${String(item.elapsedMs).padStart(5)}ms  ${cats}  ${item.endpoint}`);
  }
  if (bad.length) {
    console.log(`\n不可用 ${bad.length} 个：`);
    for (const item of bad) {
      console.log(`  ${pad(item.status, 11)} ${pad(item.id, 12)} ${item.note || ''}  ${item.endpoint}`);
    }
  }
  console.log(`\n结论：${ok.length} 可用 / ${results.length} 总计（只读探测，未修改源包）`);
})();
