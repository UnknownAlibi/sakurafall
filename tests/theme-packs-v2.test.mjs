import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeRoot = path.join(root, 'extensions', 'bundled', 'themes');
const expectedThemes = new Map([
  ['sakurafall-default', '樱月放映室'],
  ['night-stage', '霓虹夜航'],
  ['manga-ink', '漫画工坊'],
  ['forest-fresh', '森语祭典'],
  ['summer-splash', '海盐假日'],
  ['snow-noel', '雪夜星灯']
]);

test('built-in v3 theme worlds pair each background with the matching Yingyue outfit', () => {
  for (const [id, name] of expectedThemes) {
    const pack = JSON.parse(fs.readFileSync(path.join(themeRoot, `${id}.json`), 'utf8'));
    assert.equal(pack.metadata.name, name);
    assert.equal(pack.metadata.version, '3.0.0');
    assert.equal(pack.content.assetFiles.background, `${id}/assets/background.webp`);

    const background = path.join(themeRoot, pack.content.assetFiles.background);
    assert.ok(fs.existsSync(background), `${id} background should exist`);
    assert.ok(fs.statSync(background).size < 2 * 1024 * 1024, `${id} background should stay under 2MB`);

    if (id !== 'sakurafall-default') {
      assert.equal(pack.content.assetFiles.mascot, `${id}/assets/mascot.webp`);
      assert.equal(pack.content.assetFiles.emptyState, `${id}/assets/mascot.webp`);
      assert.equal(pack.content.assetFiles.cursorDefault, undefined);

      const mascot = path.join(themeRoot, pack.content.assetFiles.mascot);
      assert.ok(fs.existsSync(mascot), `${id} mascot should exist`);
      assert.ok(fs.statSync(mascot).size < 2 * 1024 * 1024, `${id} mascot should stay under 2MB`);
    }
  }
});

test('settings exposes the default world and ships real preview images for all built-ins', () => {
  const settings = fs.readFileSync(path.join(root, 'src', 'renderer', 'views', 'Settings.vue'), 'utf8');
  assert.match(settings, /this\.themePacks = packs;/);
  assert.doesNotMatch(settings, /filter\(pack => pack\.id !== 'sakurafall-default'\)/);

  for (const id of expectedThemes.keys()) {
    const preview = path.join(root, 'src', 'renderer', 'assets', 'generated', `theme-preview-${id}.webp`);
    assert.ok(fs.existsSync(preview), `${id} preview should exist`);
    assert.ok(fs.statSync(preview).size < 128 * 1024, `${id} preview should stay lightweight`);
  }
});
