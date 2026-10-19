// GPU 合成开关（设置页）持久化与启动期判定
// 运行: node --test tests/gpu-compositing-preference.test.mjs
//
// 背景：disable-gpu-compositing 默认开启（全屏兼容），使整页走 CPU 合成。
// 设置页允许切回 GPU 合成，但 Chromium 开关只能在 app ready 前决定，
// 所以开关必须先落盘、重启后读取。这里锁住读写与降级语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  GPU_COMPOSITING_FILE_NAME,
  resolveGpuCompositingPreferenceFile,
  readGpuCompositingPreference,
  writeGpuCompositingPreference,
  isGpuCompositingForcedByEnv
} = require('../src/main/utils/gpuCompositingPreference.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-gpu-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('偏好文件缺失时返回 null（由调用方使用默认的 GPU 合成）', () => {
  withTempDir(dir => {
    const file = resolveGpuCompositingPreferenceFile(dir);
    assert.equal(path.basename(file), GPU_COMPOSITING_FILE_NAME);
    assert.equal(readGpuCompositingPreference(file), null);
  });
});

test('写入后可以读回，并按 enabled === true 判定', () => {
  withTempDir(dir => {
    const file = resolveGpuCompositingPreferenceFile(dir);
    writeGpuCompositingPreference(file, true);
    assert.equal(readGpuCompositingPreference(file), true);
    writeGpuCompositingPreference(file, false);
    assert.equal(readGpuCompositingPreference(file), false);
  });
});

test('文件损坏或取值不是布尔时返回 null（回退默认值）', () => {
  withTempDir(dir => {
    const file = resolveGpuCompositingPreferenceFile(dir);
    fs.writeFileSync(file, '{ not json', 'utf8');
    assert.equal(readGpuCompositingPreference(file), null);

    fs.writeFileSync(file, JSON.stringify({ enabled: 'yes' }), 'utf8');
    assert.equal(readGpuCompositingPreference(file), null);
  });
});

test('显式关闭会保留 false，不会被默认值吞掉', () => {
  withTempDir(dir => {
    const file = resolveGpuCompositingPreferenceFile(dir);
    writeGpuCompositingPreference(file, false);
    assert.equal(readGpuCompositingPreference(file), false);
  });
});

test('带 BOM 的文件仍能正确解析（外部编辑器写入的常见情况）', () => {
  withTempDir(dir => {
    const file = resolveGpuCompositingPreferenceFile(dir);
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ enabled: true })}`, 'utf8');
    assert.equal(readGpuCompositingPreference(file), true);
  });
});

test('路径缺失时读取不抛错、写入明确报错', () => {
  assert.equal(readGpuCompositingPreference(''), null);
  assert.throws(() => writeGpuCompositingPreference('', true), /路径缺失/);
});

test('环境变量与启动参数都能强制开启 GPU 合成', () => {
  assert.equal(isGpuCompositingForcedByEnv({ SAKURAFALL_GPU_COMPOSITING: '1' }, []), true);
  assert.equal(isGpuCompositingForcedByEnv({ SAKURAFALL_GPU_COMPOSITING: '0' }, []), false);
  assert.equal(isGpuCompositingForcedByEnv({}, ['electron', '.', '--gpu-compositing']), true);
  assert.equal(isGpuCompositingForcedByEnv({}, ['electron', '.']), false);
});

test('主进程启动时把偏好文件传给全屏兼容开关', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  assert.match(source, /resolveGpuCompositingPreferenceFile\(app\.getPath\('userData'\)\)/);
  assert.match(source, /applyFullscreenCompatFlags\(\{\s*preferenceFile:/);
});

test('默认档只关 DirectComposition，只有显式关闭才退回 CPU 合成', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/window-fullscreen.js'), 'utf8');
  // 默认分支（preference !== false）必须先出现 disable-direct-composition
  const defaultBranch = source.match(/preference !== false\)\s*\{[\s\S]*?\n {4}\}/);
  assert.ok(defaultBranch, '未找到默认呈现策略分支');
  assert.match(defaultBranch[0], /appendSwitch\('disable-direct-composition'\)/);
  assert.doesNotMatch(defaultBranch[0], /disable-gpu-compositing/);
});
