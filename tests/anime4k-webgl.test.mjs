import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  Anime4kEngine,
  parseShaderPasses,
  evaluateMpvExpr,
  resolveCanvasOutputSize,
  resolveRealtimeAnime4kPreset
} from '../src/renderer/player/anime4kWebgl.js';

test('canvas output follows display size, DPI and texture limit', () => {
  assert.deepEqual(resolveCanvasOutputSize({
    cssWidth: 1920,
    cssHeight: 1080,
    pixelRatio: 1.25,
    maxTextureSize: 4096
  }), [2400, 1350]);

  // DPR 上限为 2，避免系统高缩放让实时 CNN 负载失控。
  assert.deepEqual(resolveCanvasOutputSize({
    cssWidth: 1000,
    cssHeight: 500,
    pixelRatio: 3,
    maxTextureSize: 4096
  }), [2000, 1000]);

  // 超出纹理上限时等比缩小，不能把播放画面拉伸变形。
  assert.deepEqual(resolveCanvasOutputSize({
    cssWidth: 6000,
    cssHeight: 3000,
    pixelRatio: 1,
    maxTextureSize: 4096
  }), [4096, 2048]);

  assert.deepEqual(resolveCanvasOutputSize({
    cssWidth: 3840,
    cssHeight: 2160,
    pixelRatio: 1,
    maxTextureSize: 8192,
    maxOutputEdge: 1920
  }), [1920, 1080]);
});

test('realtime preset protects fullscreen playback from oversized CNN workloads', () => {
  assert.equal(resolveRealtimeAnime4kPreset('quality', 1920, 1080), 'light');
  assert.equal(resolveRealtimeAnime4kPreset('quality', 1280, 720), 'balanced');
  assert.equal(resolveRealtimeAnime4kPreset('quality', 854, 480), 'quality');
  assert.equal(resolveRealtimeAnime4kPreset('balanced', 1280, 720), 'balanced');
});

test('fullscreen keeps the WebGPU worker path and only uses display enhancement as fallback', () => {
  const source = fs.readFileSync(new URL('../src/renderer/components/Player/Anime4KCanvas.vue', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('async start()'), source.indexOf('cleanupRuntime() {', source.indexOf('async start()')));
  assert.ok(start.indexOf('createWebgpuBackend') < start.indexOf('this.isFullscreen()'));
  assert.match(source, /createAnime4kWebgpuPipeline/);
  assert.match(source, /webgpu-worker/);
  assert.match(source, /anime4k-fullscreen-safe/);
  assert.match(source, /fullscreenchange/);
});

test('texture pool rejects duplicate GPU targets', () => {
  const engine = Object.create(Anime4kEngine.prototype);
  engine.texturePool = new Map();
  const target = { tex: {}, fbo: {}, w: 1280, h: 720, components: 4 };
  engine._releaseTarget(target);
  engine._releaseTarget({ ...target });
  assert.equal(engine.texturePool.get('1280:720:4').length, 1);
});

test('parses mpv hook shader into ordered passes', () => {
  const source = [
    '//!DESC Test-Pass-1',
    '//!HOOK MAIN',
    '//!BIND MAIN',
    '//!SAVE conv2d_tf',
    '//!WIDTH MAIN.w',
    '//!HEIGHT MAIN.h',
    '//!COMPONENTS 4',
    'vec4 hook() { return MAIN_tex(MAIN_pos); }',
    '',
    '//!DESC Test-Pass-2',
    '//!HOOK MAIN',
    '//!BIND conv2d_tf',
    '//!BIND MAIN',
    '//!SAVE MAIN',
    '//!WIDTH conv2d_tf.w 2 *',
    '//!HEIGHT conv2d_tf.h 2 *',
    'vec4 hook() { return conv2d_tf_texOff(vec2(1.0, 0.0)) + MAIN_tex(MAIN_pos); }'
  ].join('\n');

  const passes = parseShaderPasses(source);
  assert.equal(passes.length, 2);

  assert.equal(passes[0].desc, 'Test-Pass-1');
  assert.equal(passes[0].hook, 'MAIN');
  assert.deepEqual(passes[0].binds, ['MAIN']);
  assert.equal(passes[0].save, 'conv2d_tf');
  assert.equal(passes[0].widthExpr, 'MAIN.w');
  assert.equal(passes[0].components, 4);
  assert.match(passes[0].body, /vec4 hook\(\)/);

  // SAVE 缺省回落 HOOKED；WIDTH/HEIGHT 缺省回落 HOOKED 尺寸
  assert.equal(passes[1].save, 'MAIN');
  assert.deepEqual(passes[1].binds, ['conv2d_tf', 'MAIN']);
  assert.equal(passes[1].widthExpr, 'conv2d_tf.w 2 *');
  assert.equal(passes[1].components, 4);
});

test('SAVE without directive defaults to HOOKED with same-size output', () => {
  const passes = parseShaderPasses('//!DESC D\n//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }');
  assert.equal(passes.length, 1);
  assert.equal(passes[0].save, 'HOOKED');
  assert.equal(passes[0].widthExpr, 'HOOKED.w');
  assert.equal(passes[0].components, 4);
});

test('WHEN directive is captured for runtime evaluation', () => {
  const passes = parseShaderPasses([
    '//!DESC U',
    '//!HOOK MAIN',
    '//!BIND MAIN',
    '//!WHEN OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *'
  ].join('\n'));
  assert.equal(passes[0].whenExpr, 'OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *');
});

test('evaluateMpvExpr computes size expressions', () => {
  const sizes = { MAIN: [1920, 1080], OUTPUT: [3840, 2160] };
  const resolve = (name) => sizes[name];
  assert.equal(evaluateMpvExpr('MAIN.w', resolve), 1920);
  assert.equal(evaluateMpvExpr('MAIN.h 2 *', resolve), 2160);
  assert.equal(evaluateMpvExpr('MAIN.w MAIN.w /', resolve), 1);
});

test('evaluateMpvExpr handles boolean WHEN semantics', () => {
  const resolve = (name) => (name === 'MAIN' ? [1920, 1080] : name === 'OUTPUT' ? [3840, 2160] : null);
  // 3840/1920 = 2 > 1.2 → true；两个比较的 AND（mpv 用 * 表示逻辑与）
  assert.ok(evaluateMpvExpr('OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *', resolve));
  // 输出与输入同尺寸 → 1 > 1.2 为 false
  const same = () => [1920, 1080];
  assert.ok(!evaluateMpvExpr('OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *', same));
  // OR（mpv 用 + 表示逻辑或）
  assert.ok(evaluateMpvExpr('1.0 0.0 < 1.0 0.0 > +', same));
});

test('evaluateMpvExpr throws on unknown texture or malformed expression', () => {
  assert.throws(() => evaluateMpvExpr('UNKNOWN.w', () => null));
  assert.throws(() => evaluateMpvExpr('+', () => null));
  assert.throws(() => evaluateMpvExpr('MAIN.z', () => [1, 1]));
});

test('parses real bundled Anime4K shaders (smoke)', async () => {
  const { ANIME4K_SHADERS, ANIME4K_PRESETS } = await import('../src/renderer/player/anime4kShaders.js');
  for (const name of Object.keys(ANIME4K_SHADERS)) {
    const passes = parseShaderPasses(ANIME4K_SHADERS[name]);
    assert.ok(passes.length >= 1, `${name} 应至少解析出一个 pass`);
    for (const pass of passes) {
      assert.ok(pass.body.includes('vec4 hook()'), `${name} pass 缺少 hook 函数`);
      assert.ok(pass.binds.length >= 1, `${name} pass 缺少 BIND`);
    }
  }
  // Restore S：4 个 pass，最后一个写回 MAIN
  const restore = parseShaderPasses(ANIME4K_SHADERS['Anime4K_Restore_CNN_Soft_S.glsl']);
  assert.equal(restore.length, 4);
  assert.equal(restore[restore.length - 1].save, 'MAIN');
  // Upscale S：Depth-to-Space 输出 2 倍尺寸
  const upscale = parseShaderPasses(ANIME4K_SHADERS['Anime4K_Upscale_CNN_x2_S.glsl']);
  const last = upscale[upscale.length - 1];
  assert.equal(last.save, 'MAIN');
  assert.equal(last.widthExpr, 'conv2d_last_tf.w 2 *');
  // 预设引用的 shader 均存在
  for (const names of Object.values(ANIME4K_PRESETS)) {
    for (const n of names) assert.ok(ANIME4K_SHADERS[n], `预设引用了缺失的 shader ${n}`);
  }
});
