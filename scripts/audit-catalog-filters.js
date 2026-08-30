const fs = require('node:fs');
const path = require('node:path');
const { SubjectService } = require('../src/main/services/SubjectService');

const ROOT = path.resolve(__dirname, '..');
const viewSource = fs.readFileSync(path.join(ROOT, 'src/renderer/views/AnimeZone.vue'), 'utf8');
const browseTags = [...viewSource.matchAll(/mode:\s*'browse',\s*tag:\s*'([^']+)'/g)]
  .map(match => match[1]);
const regions = [
  ['日漫', '日本'],
  ['国漫', '中国'],
  ['欧美', '欧美'],
  ['韩国', '韩国']
];
const catalogs = [
  ['全部', null],
  ['TV', 1],
  ['OVA', 2],
  ['剧场版', 3],
  ['WEB', 5]
];

function printRows(title, rows) {
  console.log(`\n${title}`);
  console.table(rows);
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

async function main() {
  const service = new SubjectService();
  const catalogRows = [];
  for (const [name, cat] of catalogs) {
    const latest = await service.catalog({ sort: 'date', cat, page: 1, limit: 24, refresh: true });
    const rating = await service.catalog({ sort: 'score', cat, page: 1, limit: 24, refresh: true });
    catalogRows.push({
      filter: name,
      latestTotal: latest.total,
      ratingTotal: rating.total,
      equal: latest.total === rating.total,
      latestItems: latest.data?.length || 0,
      ratingItems: rating.data?.length || 0
    });
  }
  printRows('目录与平台', catalogRows);

  const regionRows = [];
  for (const [name, tag] of regions) {
    const latest = await service.browse({ tags: [tag], sort: 'date', page: 1, limit: 24, refresh: true });
    const rating = await service.browse({ tags: [tag], sort: 'score', page: 1, limit: 24 });
    regionRows.push({
      filter: name,
      tag,
      latestTotal: latest.total,
      ratingTotal: rating.total,
      equal: latest.total === rating.total,
      capped: !!latest._truncated
    });
  }
  printRows('地区', regionRows);

  const tagRows = await mapLimited(browseTags, 4, async tag => {
    try {
      const result = await service._requestBrowsePage({ userTags: [tag], limit: 1, offset: 0 });
      return { tag, sourceTotal: result.total, hasData: (result.data?.length || 0) > 0 };
    } catch (error) {
      return { tag, sourceTotal: 0, hasData: false, error: error.message };
    }
  });
  printRows('题材标签', tagRows);

  const inconsistent = [...catalogRows, ...regionRows].filter(row => !row.equal);
  const invalidTags = tagRows.filter(row => !row.hasData);
  if (inconsistent.length > 0 || invalidTags.length > 0) {
    console.error(`\n审计失败：${inconsistent.length} 个排序总数不一致，${invalidTags.length} 个题材标签无数据。`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n审计通过：${catalogRows.length} 个目录、${regionRows.length} 个地区、${tagRows.length} 个题材选项。`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
