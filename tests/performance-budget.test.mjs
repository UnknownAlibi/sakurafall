import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgets = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/performance-budgets.json'), 'utf8'));

test('performance budgets are explicit and internally consistent', () => {
  assert.ok(budgets.startup.packagedReadyMs >= 1000);
  assert.ok(budgets.startup.packagedReadyMs <= 15000);
  assert.ok(budgets.scroll.targetFps >= budgets.scroll.minimumFps);
  assert.ok(budgets.scroll.minimumFps >= 40);
  assert.ok(budgets.scroll.maximumLongFrameRatio > 0 && budgets.scroll.maximumLongFrameRatio < 0.5);
  assert.ok(budgets.operations['scroll-frame'] <= 1000 / budgets.scroll.minimumFps);
});

test('AnimeZone stays within the coordinator size guardrail', () => {
  const file = fs.readFileSync(path.join(root, 'src/renderer/views/AnimeZone.vue'), 'utf8');
  assert.ok(file.split(/\r?\n/).length <= budgets.sourceLimits.animeZoneMaxLines, 'AnimeZone exceeded line budget; extract another responsibility');
  assert.ok(Buffer.byteLength(file) <= budgets.sourceLimits.animeZoneMaxBytes, 'AnimeZone exceeded byte budget; remove legacy code or scoped CSS');
  assert.match(file, /AnimeCatalogToolbar/);
  assert.match(file, /AnimeCatalogGrid/);
  assert.match(file, /animeCatalogVirtualization/);
  // 详情弹窗逻辑已抽到共享 mixin，协调器调用守卫转移到 mixin 文件
  assert.match(file, /animeDetailModal/);
  const mixinFile = fs.readFileSync(path.join(root, 'src/renderer/mixins/animeDetailModal.js'), 'utf8');
  assert.match(mixinFile, /coordinateSubjectDetail/);
});

test('giant entry files stay within ratchet budgets (shrink-only)', () => {
  // 棘轮守卫：预算锁定当前体积，新增代码必须先抽离职责（mixin/composable/服务）再写入。
  // 拆分后应同步下调预算，只许变小。
  const targets = [
    { file: 'src/renderer/components/Player/VideoPlayer.vue', maxLines: budgets.sourceLimits.videoPlayerMaxLines, maxBytes: budgets.sourceLimits.videoPlayerMaxBytes },
    { file: 'src/renderer/views/Settings.vue', maxLines: budgets.sourceLimits.settingsMaxLines, maxBytes: budgets.sourceLimits.settingsMaxBytes },
    { file: 'src/main/index.js', maxLines: budgets.sourceLimits.mainIndexMaxLines, maxBytes: budgets.sourceLimits.mainIndexMaxBytes }
  ];
  for (const target of targets) {
    const content = fs.readFileSync(path.join(root, target.file), 'utf8');
    const lines = content.split(/\r?\n/).length;
    assert.ok(lines <= target.maxLines, `${target.file} exceeded line budget (${lines} > ${target.maxLines}); extract another responsibility`);
    assert.ok(Buffer.byteLength(content) <= target.maxBytes, `${target.file} exceeded byte budget; remove legacy code or scoped CSS`);
  }
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
