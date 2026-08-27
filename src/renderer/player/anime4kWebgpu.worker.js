const PRESENT_VERTEX = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn main(@builtin(vertex_index) index: u32) -> VertexOutput {
  const positions = array(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  const uvs = array(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}`;

const PRESENT_FRAGMENT = `
struct Presentation {
  sourceAspect: f32,
  outputAspect: f32,
  padding0: f32,
  padding1: f32,
}

@group(0) @binding(0) var sourceSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> presentation: Presentation;

@fragment
fn main(@location(0) inputUv: vec2f) -> @location(0) vec4f {
  var uv = inputUv;
  if (presentation.sourceAspect > presentation.outputAspect) {
    let contentHeight = presentation.outputAspect / presentation.sourceAspect;
    let margin = (1.0 - contentHeight) * 0.5;
    if (uv.y < margin || uv.y > 1.0 - margin) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    uv.y = (uv.y - margin) / contentHeight;
  } else if (presentation.sourceAspect < presentation.outputAspect) {
    let contentWidth = presentation.sourceAspect / presentation.outputAspect;
    let margin = (1.0 - contentWidth) * 0.5;
    if (uv.x < margin || uv.x > 1.0 - margin) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    uv.x = (uv.x - margin) / contentWidth;
  }
  return textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0);
}`;

let state = null;
let rendering = false;
let disposed = false;

function waitForSubmittedWork(device, timeoutMs, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
  });
  return Promise.race([device.queue.onSubmittedWorkDone(), timeout])
    .finally(() => clearTimeout(timeoutId));
}

async function submitPipelinePass(current, label, timeoutMs) {
  const encoder = current.device.createCommandEncoder({ label });
  current.pipeline.pass(encoder);
  current.device.queue.submit([encoder.finish()]);
  await waitForSubmittedWork(current.device, timeoutMs, label);
}

async function warmupPipeline(current) {
  await submitPipelinePass(current, 'Anime4K GPU 预热', 12000);
  const startedAt = performance.now();
  await submitPipelinePass(current, 'Anime4K GPU 实时能力检测', 3000);
  return performance.now() - startedAt;
}

function postFatal(error) {
  self.postMessage({ type: 'fatal', message: error?.message || String(error || 'WebGPU Worker 异常') });
}

async function buildAnime4kPipeline(device, inputTexture, profile) {
  const library = await import('anime4k-webgpu');
  const Pipeline = library[profile.pipeline];
  if (typeof Pipeline !== 'function') throw new Error(`Anime4K 管线不存在：${profile.pipeline}`);
  return new Pipeline({ device, inputTexture });
}

function writePresentationUniforms(current) {
  const sourceTexture = current.pipeline.getOutputTexture();
  const values = new Float32Array([
    sourceTexture.width / Math.max(1, sourceTexture.height),
    current.canvas.width / Math.max(1, current.canvas.height),
    0,
    0
  ]);
  current.device.queue.writeBuffer(current.presentationBuffer, 0, values);
}

async function initialize(message) {
  if (!self.navigator?.gpu) throw new Error('Worker 中 WebGPU 不可用');
  const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('未找到可用的 WebGPU 显卡适配器');
  const device = await adapter.requestDevice();
  const canvas = message.canvas;
  canvas.width = message.outputWidth;
  canvas.height = message.outputHeight;
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('OffscreenCanvas 无法创建 WebGPU 上下文');
  const format = self.navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const inputTexture = device.createTexture({
    label: 'Anime4K video input',
    size: [message.inputWidth, message.inputHeight, 1],
    format: 'rgba16float',
    usage: self.GPUTextureUsage.TEXTURE_BINDING | self.GPUTextureUsage.COPY_DST | self.GPUTextureUsage.RENDER_ATTACHMENT
  });

  device.pushErrorScope('validation');
  const pipeline = await buildAnime4kPipeline(device, inputTexture, message.profile);
  const presentationBuffer = device.createBuffer({
    label: 'Anime4K presentation uniforms',
    size: 16,
    usage: self.GPUBufferUsage.UNIFORM | self.GPUBufferUsage.COPY_DST
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: self.GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: self.GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: self.GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
    ]
  });
  const presentationPipeline = device.createRenderPipeline({
    label: 'Anime4K presentation pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: device.createShaderModule({ code: PRESENT_VERTEX }), entryPoint: 'main' },
    fragment: {
      module: device.createShaderModule({ code: PRESENT_FRAGMENT }),
      entryPoint: 'main',
      targets: [{ format }]
    },
    primitive: { topology: 'triangle-list' }
  });
  const presentationBindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
      { binding: 1, resource: pipeline.getOutputTexture().createView() },
      { binding: 2, resource: { buffer: presentationBuffer } }
    ]
  });
  const validationError = await device.popErrorScope();
  if (validationError) throw new Error(validationError.message);

  state = {
    adapter,
    device,
    canvas,
    context,
    format,
    inputTexture,
    pipeline,
    presentationBuffer,
    presentationPipeline,
    presentationBindGroup,
    inputWidth: message.inputWidth,
    inputHeight: message.inputHeight,
    profile: message.profile
  };
  writePresentationUniforms(state);
  // WebGPU defers shader compilation until the first submission. Compile while
  // the native video is still visible so enabling Anime4K cannot freeze frame 1.
  const benchmarkMs = await warmupPipeline(state);
  // A 24 fps source has 41.7 ms per frame. Leave a little headroom for decode,
  // presentation and UI work; otherwise the enhanced canvas would visibly lag.
  if (benchmarkMs > 36) {
    throw new Error(`CNN 实时性能不足（${benchmarkMs.toFixed(0)}ms/帧）`);
  }
  device.lost.then((info) => {
    if (!disposed) postFatal(new Error(`WebGPU 设备已丢失：${info.message || info.reason}`));
  });
  device.addEventListener('uncapturederror', (event) => postFatal(event.error));
  self.postMessage({
    type: 'ready',
    profile: {
      ...message.profile,
      outputWidth: pipeline.getOutputTexture().width,
      outputHeight: pipeline.getOutputTexture().height,
      benchmarkMs,
      adapterDescription: adapter.info?.description || adapter.info?.device || ''
    }
  });
}

function resize(message) {
  if (!state) return;
  const width = Math.max(1, Number(message.outputWidth) || 1);
  const height = Math.max(1, Number(message.outputHeight) || 1);
  if (state.canvas.width === width && state.canvas.height === height) return;
  state.canvas.width = width;
  state.canvas.height = height;
  writePresentationUniforms(state);
}

async function renderFrame(message) {
  const frame = message.frame;
  if (!state || rendering || disposed) {
    frame?.close();
    return;
  }
  rendering = true;
  const startedAt = performance.now();
  try {
    state.device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: state.inputTexture },
      [state.inputWidth, state.inputHeight]
    );
    frame.close();
    const encoder = state.device.createCommandEncoder({ label: `Anime4K frame ${message.id}` });
    state.pipeline.pass(encoder);
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: state.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    renderPass.setPipeline(state.presentationPipeline);
    renderPass.setBindGroup(0, state.presentationBindGroup);
    renderPass.draw(6);
    renderPass.end();
    state.device.queue.submit([encoder.finish()]);
    await waitForSubmittedWork(state.device, 1500, 'Anime4K 单帧渲染');
    self.postMessage({ type: 'frame-complete', id: message.id, renderMs: performance.now() - startedAt });
  } catch (error) {
    try { frame?.close(); } catch (_) { /* frame may already be closed */ }
    postFatal(error);
  } finally {
    rendering = false;
  }
}

function dispose() {
  disposed = true;
  try { state?.context?.unconfigure?.(); } catch (_) { /* canvas may already be detached */ }
  try { state?.inputTexture?.destroy(); } catch (_) { /* device may already be lost */ }
  try { state?.presentationBuffer?.destroy(); } catch (_) { /* device may already be lost */ }
  try { state?.device?.destroy?.(); } catch (_) { /* device may already be lost */ }
  state = null;
  self.close();
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'initialize') {
    initialize(message).catch(postFatal);
  } else if (message.type === 'resize') {
    resize(message);
  } else if (message.type === 'frame') {
    renderFrame(message);
  } else if (message.type === 'dispose') {
    dispose();
  }
};
