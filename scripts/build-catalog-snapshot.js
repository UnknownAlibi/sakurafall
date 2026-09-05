const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = [
  { id: 0, platform: '其他' },
  { id: 1, platform: 'TV' },
  { id: 2, platform: 'OVA' },
  { id: 3, platform: '剧场版' },
  { id: 5, platform: 'WEB' }
];
const UPSTREAMS = String(process.env.SAKURAFALL_BANGUMI_UPSTREAMS || 'https://bgmapi.anibt.net,https://api.bangumi.lol,https://api.bgm.tv')
  .split(',')
  .map(value => value.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const PAGE_SIZE = 100;
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SAKURAFALL_CATALOG_BUILD_CONCURRENCY) || 4));
const OUTPUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'artifacts', 'catalog-snapshot.json'));
const CHECKPOINT = `${OUTPUT}.pages`;

async function fetchJson(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SakuraFall-Catalog-Builder/1.0',
        Referer: 'https://bgm.tv/'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function requestPage(category, limit, offset, attempt = 0) {
  let lastError = null;
  for (let index = 0; index < UPSTREAMS.length; index += 1) {
    const upstream = UPSTREAMS[(attempt + index + Math.floor(offset / PAGE_SIZE)) % UPSTREAMS.length];
    const query = new URLSearchParams({
      type: '2',
      cat: String(category.id),
      sort: 'date',
      limit: String(limit),
      offset: String(offset)
    });
    try {
      const page = await fetchJson(`${upstream}/v0/subjects?${query}`);
      const expected = Math.min(limit, Math.max(0, Number(page.total) - offset));
      if (!Array.isArray(page.data) || !Number.isFinite(Number(page.total)) ||
          page.data.length < expected || page.data.some(item => !Number(item?.id))) {
        throw new Error('Incomplete catalog page');
      }
      return page;
    } catch (error) {
      lastError = error;
    }
  }
  if (attempt < 2) {
    await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    return requestPage(category, limit, offset, attempt + 1);
  }
  throw new Error(`${category.platform} offset=${offset}: ${lastError?.message || '请求失败'}`);
}

async function mapLimited(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function writeSnapshot(subjects) {
  const generatedAt = Date.now();
  const payload = {
    fileVersion: 1,
    generatedAt,
    lastFullWarmAt: generatedAt,
    records: [...subjects.values()].map(subject => ({ subject, updatedAt: generatedAt }))
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const temporaryPath = `${OUTPUT}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(payload));
  fs.renameSync(temporaryPath, OUTPUT);
  return { generatedAt, total: subjects.size, bytes: fs.statSync(OUTPUT).size };
}

async function main() {
  fs.mkdirSync(CHECKPOINT, { recursive: true });
  const totals = await mapLimited(CATEGORIES, CATEGORIES.length, async category => {
    const first = await requestPage(category, 1, 0);
    const total = Math.max(0, Number(first.total) || 0);
    process.stdout.write(`[CatalogBuilder] ${category.platform}: ${total}\n`);
    return { category, total };
  });
  const jobs = totals.flatMap(({ category, total }) => (
    Array.from({ length: Math.ceil(total / PAGE_SIZE) }, (_, index) => ({
      category,
      offset: index * PAGE_SIZE
    }))
  ));
  const subjects = new Map();
  let completed = 0;
  await mapLimited(jobs, CONCURRENCY, async job => {
    const cachePath = path.join(CHECKPOINT, `${job.category.id}-${job.offset}.json`);
    let page;
    try {
      if (Date.now() - fs.statSync(cachePath).mtimeMs < 24 * 60 * 60 * 1000) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (Array.isArray(cached.data) && cached.data.length > 0) page = cached;
      }
    } catch (_) { /* A missing checkpoint is fetched normally. */ }
    if (!page) {
      page = await requestPage(job.category, PAGE_SIZE, job.offset);
      const temporaryPath = `${cachePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(page));
      fs.renameSync(temporaryPath, cachePath);
    }
    for (const item of page.data || []) {
      const id = Number(item?.id);
      if (!id) continue;
      subjects.set(id, {
        ...subjects.get(id),
        ...item,
        platform: item.platform || job.category.platform
      });
    }
    completed += 1;
    if (completed % 10 === 0 || completed === jobs.length) {
      process.stdout.write(`[CatalogBuilder] ${completed}/${jobs.length} pages, ${subjects.size} subjects\n`);
    }
  });
  const result = writeSnapshot(subjects);
  process.stdout.write(`[CatalogBuilder] complete: ${result.total} subjects, ${result.bytes} bytes, ${OUTPUT}\n`);
}

main().catch(error => {
  console.error('[CatalogBuilder] failed:', error.message);
  process.exitCode = 1;
});
