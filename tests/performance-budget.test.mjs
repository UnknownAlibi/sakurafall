import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgets = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/performance-budgets.json'), 'utf8'));

// 体积预算按「代码体积」衡量，必须与检出的换行符无关。
// 仓库 core.autocrlf=true（Windows 检出即 CRLF），同一文件 CRLF 比 LF 多出约
// 「行数」个字节（3000 行的文件差约 3KB），足以让预算在 CI/本地之间摇摆。
// 这里统一归一化为 LF 后再量字节，保证 gate 在两个平台结果一致。
function readSource(relativePath) {
  const raw = fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
  return { raw, lines: raw.split('\n').length, bytes: Buffer.byteLength(raw) };
}

/** src 下所有代码文件（js/vue），按行数降序 —— 用于「前 N 名必须受守」的元守卫 */
function listSourceFilesBySize() {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|vue)$/.test(entry.name)) {
        const { lines, bytes } = readSource(path.relative(root, full).split(path.sep).join('/'));
        found.push({ path: path.relative(root, full).split(path.sep).join('/'), lines, bytes });
      }
    }
  })(path.join(root, 'src'));
  return found.sort((a, b) => b.lines - a.lines);
}

const RATCHET = budgets.sourceLimits?.ratchet || [];
const ratchetPaths = new Set(RATCHET.map(entry => entry.path));

test('performance budgets are explicit and internally consistent', () => {
  assert.ok(budgets.startup.packagedReadyMs >= 1000);
  assert.ok(budgets.startup.packagedReadyMs <= 15000);
  assert.ok(budgets.scroll.targetFps >= budgets.scroll.minimumFps);
  assert.ok(budgets.scroll.minimumFps >= 40);
  assert.ok(budgets.scroll.maximumLongFrameRatio > 0 && budgets.scroll.maximumLongFrameRatio < 0.5);
  assert.ok(budgets.operations['scroll-frame'] <= 1000 / budgets.scroll.minimumFps);

  // 棘轮清单本身要自洽：条目完整、路径存在、不重复
  assert.ok(RATCHET.length >= 10, '棘轮至少应覆盖 10 个文件');
  assert.strictEqual(ratchetPaths.size, RATCHET.length, '棘轮清单存在重复路径');
  for (const entry of RATCHET) {
    assert.match(entry.path, /^src\/.+\.(js|vue)$/, `棘轮条目路径不合法: ${entry.path}`);
    assert.ok(Number.isInteger(entry.maxLines) && entry.maxLines > 0, `${entry.path} 缺少 maxLines`);
    assert.ok(Number.isInteger(entry.maxBytes) && entry.maxBytes > 0, `${entry.path} 缺少 maxBytes`);
    assert.ok(fs.existsSync(path.join(root, entry.path)), `棘轮条目指向的文件不存在: ${entry.path}`);
  }
});

test('AnimeZone stays within the coordinator size guardrail', () => {
  // 尺寸由下方棘轮统一校验，这里只守护「职责已抽离」的结构约定
  const { raw: file } = readSource('src/renderer/views/AnimeZone.vue');
  assert.match(file, /AnimeCatalogToolbar/);
  assert.match(file, /AnimeCatalogGrid/);
  assert.match(file, /animeCatalogVirtualization/);
  // 详情弹窗逻辑已抽到共享 mixin，协调器调用守卫转移到 mixin 文件
  assert.match(file, /animeDetailModal/);
  const mixinFile = fs.readFileSync(path.join(root, 'src/renderer/mixins/animeDetailModal.js'), 'utf8');
  assert.match(mixinFile, /coordinateSubjectDetail/);
});

test('giant entry files stay within ratchet budgets (shrink-only)', () => {
  // 棘轮守卫：预算锁定当前体积，新增代码必须先抽离职责（IPC 模块 / composable / mixin / store）再写入。
  // 目标清单写在 src/shared/performance-budgets.json 的 sourceLimits.ratchet 里 ——
  // 加守一个文件是改 JSON，不是改测试。拆分后应同步下调预算，只许变小。
  for (const entry of RATCHET) {
    const { lines, bytes } = readSource(entry.path);
    assert.ok(lines <= entry.maxLines, `${entry.path} exceeded line budget (${lines} > ${entry.maxLines}); extract another responsibility`);
    assert.ok(bytes <= entry.maxBytes, `${entry.path} exceeded byte budget (${bytes} > ${entry.maxBytes}); remove legacy code or scoped CSS`);
  }
});

test('棘轮清单必须覆盖最大的 10 个源文件（防止新的巨人文件裸奔）', () => {
  // 元守卫：只要某个文件长进体积前 N 名，这条就会红 —— 强制把它也锁进棘轮，
  // 避免 2026-08-30 评审里「只有 4 个文件受守、AnimeDetail.vue 3384 行无人管」重演。
  const topN = Number(budgets.sourceLimits?.topNFilesGuarded) || 10;
  const missing = listSourceFilesBySize()
    .slice(0, topN)
    .filter(row => !ratchetPaths.has(row.path))
    .map(row => `${row.path} (${row.lines} 行)`);
  assert.deepStrictEqual(
    missing,
    [],
    `以下文件已进入体积前 ${topN} 名，请加入 sourceLimits.ratchet 并锁定当前体积`
  );
});

test('built renderer route chunks stay below desktop budgets', { skip: !fs.existsSync(path.join(root, 'dist/renderer/assets')) }, () => {
  const assetDir = path.join(root, 'dist/renderer/assets');
  const assets = fs.readdirSync(assetDir).map(name => ({ name, size: fs.statSync(path.join(assetDir, name)).size }));
  const largest = (pattern) => assets.filter(asset => pattern.test(asset.name)).sort((a, b) => b.size - a.size)[0];
  assert.ok(largest(/^AnimeZone-.*\.js$/)?.size <= budgets.bundles.animeZoneJsBytes, 'AnimeZone JS budget exceeded');
  assert.ok(largest(/^AnimeZone-.*\.css$/)?.size <= budgets.bundles.animeZoneCssBytes, 'AnimeZone CSS budget exceeded');
  assert.ok(largest(/^main-.*\.js$/)?.size <= budgets.bundles.mainJsBytes, 'main renderer budget exceeded');
  assert.ok(largest(/^player-hls-.*\.js$/)?.size <= budgets.bundles.hlsVendorJsBytes, 'HLS vendor budget exceeded');
});
