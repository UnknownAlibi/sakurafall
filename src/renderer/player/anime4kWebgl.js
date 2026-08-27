// Anime4K WebGL2 播放引擎
// 将 mpv hook 格式的 Anime4K GLSL shader（resources/anime4k）在运行时转译为
// WebGL2 多 pass 渲染管线：video 帧 → Restore CNN → Upscale CNN ×2 → canvas。
//
// 转译约定（mpv → WebGL2）：
//   //!HOOK / //!BIND / //!SAVE   → 纹理命名表 + FBO 调度（顺序执行，等价 mpv shader 顺序）
//   <name>_tex(pos)              → texture(<name>, pos)
//   <name>_texOff(off)           → texture(<name>, v_texCoord + off * <name>_pt)
//   <name>_pos/_pt/_size         → varying / uniform vec2
//   //!WIDTH/HEIGHT/WHEN          → 后缀表达式（MPV DSL），由 JS 求值
//   //!COMPONENTS                 → R16F / RG16F / RGBA16F 渲染目标
//
// 纯浏览器 API，无 Electron 依赖；解析器为纯函数，可直接 node:test 测试。

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_texCoord;
void main() {
  v_texCoord = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// 呈现 pass：等价 CSS object-fit: contain（黑边）+ 翻转 Y（video 纹理首行在顶部）
const PRESENT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_srcSize;
uniform vec2 u_outSize;
uniform float u_sharpness;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  float srcAspect = u_srcSize.x / u_srcSize.y;
  float outAspect = u_outSize.x / u_outSize.y;
  vec2 uv = v_texCoord;
  if (srcAspect > outAspect) {
    float scale = outAspect / srcAspect;
    float band = (1.0 - scale) * 0.5;
    if (uv.y < band || uv.y > 1.0 - band) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    uv.y = (uv.y - band) / scale;
  } else if (srcAspect < outAspect) {
    float scale = srcAspect / outAspect;
    float band = (1.0 - scale) * 0.5;
    if (uv.x < band || uv.x > 1.0 - band) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    uv.x = (uv.x - band) / scale;
  }
  vec2 sourceUv = vec2(uv.x, 1.0 - uv.y);
  vec2 texel = 1.0 / u_srcSize;
  vec3 center = texture(u_tex, sourceUv).rgb;
  vec3 neighbors = (
    texture(u_tex, sourceUv + vec2(texel.x, 0.0)).rgb +
    texture(u_tex, sourceUv - vec2(texel.x, 0.0)).rgb +
    texture(u_tex, sourceUv + vec2(0.0, texel.y)).rgb +
    texture(u_tex, sourceUv - vec2(0.0, texel.y)).rgb
  ) * 0.25;
  fragColor = vec4(clamp(center + (center - neighbors) * u_sharpness, 0.0, 1.0), 1.0);
}`;

/** 解析 mpv hook GLSL 为 pass 列表（纯函数） */
export function parseShaderPasses(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const passes = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\/\/!\s*(\w+)\s*(.*)$/);
    if (!m) {
      if (current) current.body.push(line);
      continue;
    }
    const [, directive, arg] = m;
    const value = arg.trim();
    if (directive === 'DESC') {
      if (current) passes.push(finishPass(current));
      current = { desc: value, hook: '', binds: [], save: '', widthExpr: '', heightExpr: '', components: 0, whenExpr: '', body: [] };
    } else if (!current) {
      continue; // 文件头注释/license，忽略
    } else if (directive === 'HOOK') {
      current.hook = value;
    } else if (directive === 'BIND') {
      current.binds.push(value.split(/\s+/)[0]);
    } else if (directive === 'SAVE') {
      current.save = value.split(/\s+/)[0];
    } else if (directive === 'WIDTH') {
      current.widthExpr = value;
    } else if (directive === 'HEIGHT') {
      current.heightExpr = value;
    } else if (directive === 'COMPONENTS') {
      current.components = Number(value) || 4;
    } else if (directive === 'WHEN') {
      current.whenExpr = value;
    }
  }
  if (current) passes.push(finishPass(current));
  return passes;
}

function finishPass(pass) {
  return {
    desc: pass.desc,
    hook: pass.hook,
    binds: pass.binds,
    save: pass.save || 'HOOKED',
    widthExpr: pass.widthExpr || 'HOOKED.w',
    heightExpr: pass.heightExpr || 'HOOKED.h',
    components: pass.components || 4,
    whenExpr: pass.whenExpr,
    body: pass.body.join('\n').replace(/^\n+|\n+$/g, '')
  };
}

/**
 * 求值 mpv 后缀表达式（DSL）
 * token：<texName>.w/.h（由 resolve 提供尺寸）、数字、+ - * / < >
 * 返回原始数值；布尔语境（WHEN）由调用方按非 0 判真（与 mpv 一致）
 */
export function evaluateMpvExpr(expr, resolve) {
  const tokens = String(expr || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  const stack = [];
  const isOperator = (t) => t === '+' || t === '-' || t === '*' || t === '/' || t === '<' || t === '>';
  for (const token of tokens) {
    if (isOperator(token)) {
      if (stack.length < 2) throw new Error(`表达式 "${expr}" 操作数不足`);
      const b = stack.pop();
      const a = stack.pop();
      switch (token) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': stack.push(a / b); break;
        case '<': stack.push(a < b ? 1 : 0); break;
        case '>': stack.push(a > b ? 1 : 0); break;
      }
    } else if (/^[+-]?\d+(\.\d+)?$/.test(token)) {
      stack.push(Number(token));
    } else {
      const m = token.match(/^(\w+)\.(w|h)$/);
      if (!m) throw new Error(`表达式 "${expr}" 含未知 token "${token}"`);
      const size = resolve(m[1]);
      if (!size) throw new Error(`表达式 "${expr}" 引用了未知纹理 "${m[1]}"`);
      stack.push(m[2] === 'w' ? size[0] : size[1]);
    }
  }
  if (stack.length !== 1) throw new Error(`表达式 "${expr}" 求值后栈残留 ${stack.length} 个值`);
  return stack[0];
}

/**
 * 将播放区域的 CSS 尺寸换算为 WebGL 画布尺寸，同时限制 DPI 和纹理上限。
 * 单独导出便于在无 WebGL 环境下验证全屏、缩放和高 DPI 场景。
 */
export function resolveCanvasOutputSize({
  cssWidth,
  cssHeight,
  pixelRatio = 1,
  maxTextureSize = 4096,
  maxOutputEdge = Infinity,
  fallbackWidth = 1,
  fallbackHeight = 1
} = {}) {
  const safeRatio = Math.max(1, Math.min(Number(pixelRatio) || 1, 2));
  let width = Math.round((Number(cssWidth) || 0) * safeRatio);
  let height = Math.round((Number(cssHeight) || 0) * safeRatio);

  if (width <= 0 || height <= 0) {
    width = Math.max(1, Math.round(Number(fallbackWidth) || 1));
    height = Math.max(1, Math.round(Number(fallbackHeight) || 1));
  }

  const textureLimit = Math.max(1, Number(maxTextureSize) || 4096);
  const outputLimit = Number.isFinite(Number(maxOutputEdge)) ? Math.max(1, Number(maxOutputEdge)) : textureLimit;
  const limit = Math.min(textureLimit, outputLimit);
  const scale = Math.min(1, limit / width, limit / height);
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale))
  ];
}

/** 高分辨率输入优先保住播放连续性，较小输入才启用更重的 CNN。 */
export function resolveRealtimeAnime4kPreset(requestedPreset, width, height) {
  const requested = ['light', 'balanced', 'quality'].includes(requestedPreset) ? requestedPreset : 'balanced';
  const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
  if (pixels > 1280 * 720) return 'light';
  if (pixels > 960 * 540 && requested === 'quality') return 'balanced';
  return requested;
}

/** 生成 pass 的 WebGL2 fragment shader 源码（纯函数，便于测试） */
export function buildPassFragmentShader(pass) {
  const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'in vec2 v_texCoord;', 'out vec4 fragColor;', ''];
  const samplers = [...new Set(pass.binds)];
  for (const name of samplers) {
    lines.push(`uniform sampler2D ${name};`);
    lines.push(`uniform vec2 ${name}_size;`);
    lines.push(`uniform vec2 ${name}_pt;`);
    lines.push(`#define ${name}_pos v_texCoord`);
    lines.push(`#define ${name}_tex(__p) texture(${name}, __p)`);
    lines.push(`#define ${name}_texOff(__o) texture(${name}, v_texCoord + __o * ${name}_pt)`);
  }
  lines.push('');
  lines.push(pass.body);
  lines.push('');
  lines.push('void main() { fragColor = hook(); }');
  return lines.join('\n');
}

/** WebGL2 引擎：管理纹理池、pass 编译与逐帧执行 */
export class Anime4kEngine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.maxOutputEdge = Number(options.maxOutputEdge) || 1920;
    this.sharpness = Math.max(0, Math.min(Number(options.sharpness) || 0, 0.6));
    // 注意：不设 powerPreference/preserveDrawingBuffer——
    // 双显卡机器上强制独显渲染 + 集显合成是 WebGL 花屏的经典根因；
    // 每帧全量重绘也不需要 preserveDrawingBuffer（其拷贝路径在部分驱动上产生伪影）。
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false
    });
    if (!this.gl) throw new Error('WebGL2 不可用');
    this.floatRenderable = !!this.gl.getExtension('EXT_color_buffer_float');
    if (!this.floatRenderable) throw new Error('GPU 不支持浮点渲染目标（EXT_color_buffer_float）');
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.videoTexture = null;
    this.textureMap = new Map(); // name -> { tex, fbo, w, h, format }
    this.texturePool = new Map(); // "w:h:fmt" -> [{ tex, fbo }]
    this.programs = []; // { program, uniformLocations: Map }
    this.passes = []; // 编译后的 pass 描述（含 program 索引）
    this.quad = null;
    this.vertexShader = null;
    this.presentProgram = null;
    this.outputSize = [0, 0];
    this._initQuad();
  }

  _initQuad() {
    const gl = this.gl;
    this.vertexShader = this._compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.quad = buffer;
    const presentFs = this._compileShader(gl.FRAGMENT_SHADER, PRESENT_FRAGMENT);
    try {
      this.presentProgram = this._linkProgram(presentFs);
    } finally {
      gl.deleteShader(presentFs);
    }
    this.presentUniforms = {
      tex: gl.getUniformLocation(this.presentProgram, 'u_tex'),
      srcSize: gl.getUniformLocation(this.presentProgram, 'u_srcSize'),
      outSize: gl.getUniformLocation(this.presentProgram, 'u_outSize'),
      sharpness: gl.getUniformLocation(this.presentProgram, 'u_sharpness')
    };
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('shader 编译失败: ' + log);
    }
    return shader;
  }

  _linkProgram(fragmentShader) {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, this.vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('program 链接失败: ' + log);
    }
    return program;
  }

  _formatFor(components) {
    const gl = this.gl;
    if (components === 1) return { internal: gl.R16F, format: gl.RED };
    if (components === 2) return { internal: gl.RG16F, format: gl.RG };
    return { internal: gl.RGBA16F, format: gl.RGBA };
  }

  _acquireTarget(w, h, components) {
    const gl = this.gl;
    const key = `${w}:${h}:${components}`;
    const pool = this.texturePool.get(key) || [];
    const cached = pool.pop();
    if (cached) {
      this.texturePool.set(key, pool);
      return cached;
    }
    const { internal, format } = this._formatFor(components);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      throw new Error('浮点渲染目标不可用（FBO 不完整）');
    }
    return { tex, fbo, w, h, components };
  }

  _releaseTarget(target) {
    if (!target) return;
    const key = `${target.w}:${target.h}:${target.components}`;
    const pool = this.texturePool.get(key) || [];
    // 同一纹理不能在池中出现两次，否则下一帧可能同时作为读纹理和写目标。
    if (!pool.some(item => item.tex === target.tex) && pool.length < 24) pool.push(target);
    this.texturePool.set(key, pool);
  }

  _buildFragmentShader(pass) {
    const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'in vec2 v_texCoord;', 'out vec4 fragColor;', ''];
    const samplers = [...new Set(pass.binds)];
    for (const name of samplers) {
      lines.push(`uniform sampler2D ${name};`);
      lines.push(`uniform vec2 ${name}_size;`);
      lines.push(`uniform vec2 ${name}_pt;`);
      lines.push(`#define ${name}_pos v_texCoord`);
      lines.push(`#define ${name}_tex(__p) texture(${name}, __p)`);
      lines.push(`#define ${name}_texOff(__o) texture(${name}, v_texCoord + __o * ${name}_pt)`);
    }
    lines.push('');
    lines.push(pass.body);
    lines.push('');
    lines.push('void main() { fragColor = hook(); }');
    return lines.join('\n');
  }

  /** 装载管线：sources 为 [{ name, glsl }]，按顺序执行 */
  loadPipeline(sources) {
    this.disposePipeline();
    const gl = this.gl;
    for (const { name, glsl } of sources) {
      const parsed = parseShaderPasses(glsl);
      for (const pass of parsed) {
        const fragment = this._buildFragmentShader(pass);
        const fs = this._compileShader(gl.FRAGMENT_SHADER, fragment);
        let program;
        try {
          program = this._linkProgram(fs);
        } finally {
          gl.deleteShader(fs);
        }
        const uniforms = new Map();
        for (const bind of new Set(pass.binds)) {
          uniforms.set(bind, gl.getUniformLocation(program, bind));
          uniforms.set(bind + '_size', gl.getUniformLocation(program, bind + '_size'));
          uniforms.set(bind + '_pt', gl.getUniformLocation(program, bind + '_pt'));
        }
        this.programs.push({ program, uniforms });
        this.passes.push({ ...pass, sourceName: name, programIndex: this.programs.length - 1 });
      }
    }
  }

  _resolveSize(name) {
    if (name === 'OUTPUT') return this.outputSize;
    if (name === 'NATIVE') return this._nativeSize();
    if (name === 'MAIN' && !this.textureMap.has('MAIN')) return this._nativeSize();
    const entry = this.textureMap.get(name);
    return entry ? [entry.w, entry.h] : null;
  }

  _nativeSize() {
    return this.videoSize || [0, 0];
  }

  setDisplaySize(cssWidth, cssHeight, pixelRatio = 1) {
    this.displaySize = [Number(cssWidth) || 0, Number(cssHeight) || 0, Number(pixelRatio) || 1];
    this._syncOutputSize();
    return [...this.outputSize];
  }

  _syncOutputSize() {
    const [cssWidth = 0, cssHeight = 0, pixelRatio = 1] = this.displaySize || [];
    const [videoWidth = 1, videoHeight = 1] = this.videoSize || [];
    const next = resolveCanvasOutputSize({
      cssWidth,
      cssHeight,
      pixelRatio,
      maxTextureSize: this.maxTextureSize,
      maxOutputEdge: this.maxOutputEdge,
      fallbackWidth: Math.min(videoWidth * 2, this.maxTextureSize),
      fallbackHeight: Math.min(videoHeight * 2, this.maxTextureSize)
    });
    this.outputSize = next;
    if (this.canvas.width !== next[0] || this.canvas.height !== next[1]) {
      this.canvas.width = next[0];
      this.canvas.height = next[1];
    }
  }

  _runPass(pass) {
    const gl = this.gl;
    const { program, uniforms } = this.programs[pass.programIndex];
    const hookedName = pass.hook || 'MAIN';
    const hookedEntry = this.textureMap.get(hookedName) || this.textureMap.get('MAIN');
    if (!hookedEntry) return;
    const resolvePassSize = (name) => name === 'HOOKED'
      ? [hookedEntry.w, hookedEntry.h]
      : this._resolveSize(name);

    // WHEN 条件（OUTPUT/NATIVE/纹理尺寸参与判断）
    if (pass.whenExpr) {
      try {
        if (!evaluateMpvExpr(pass.whenExpr, resolvePassSize)) return;
      } catch (_) {
        return; // 条件求值失败时跳过该 pass，不中断整帧
      }
    }

    const binds = [...new Set(pass.binds)];
    if (binds.length === 0) binds.push('HOOKED');

    // 计算输出尺寸
    let outW, outH;
    try {
      outW = Math.max(1, Math.round(evaluateMpvExpr(pass.widthExpr, resolvePassSize)));
      outH = Math.max(1, Math.round(evaluateMpvExpr(pass.heightExpr, resolvePassSize)));
    } catch (_) {
      return;
    }
    if (outW > this.maxTextureSize || outH > this.maxTextureSize) return;

    // 读写的同名纹理（SAVE=某 BIND）需换新目标再交换，避免同时读写
    const saveName = pass.save === 'HOOKED' ? hookedName : pass.save;
    const oldSave = this.textureMap.get(saveName) || null;
    const target = this._acquireTarget(outW, outH, pass.components);
    const saveEntry = { ...target, owned: true };

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    let unit = 0;
    for (const bind of binds) {
      const entry = bind === 'HOOKED' ? hookedEntry : this.textureMap.get(bind);
      if (!entry) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); this._releaseTarget(target); return; }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform1i(uniforms.get(bind), unit);
      gl.uniform2f(uniforms.get(bind + '_size'), entry.w, entry.h);
      gl.uniform2f(uniforms.get(bind + '_pt'), 1 / entry.w, 1 / entry.h);
      unit += 1;
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 更新命名表；被覆盖的旧纹理回收（视频纹理除外）
    this.textureMap.set(saveName, saveEntry);
    if (oldSave && oldSave.owned) this._releaseTarget({ tex: oldSave.tex, fbo: oldSave.fbo, w: oldSave.w, h: oldSave.h, components: oldSave.components || 4 });
  }

  /** 上传视频帧并执行管线 + 呈现；返回本次处理耗时(ms) */
  renderFrame(video) {
    const gl = this.gl;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return 0;
    const sizeChanged = !this.videoSize || this.videoSize[0] !== vw || this.videoSize[1] !== vh;

    if (!this.videoTexture) {
      this.videoTexture = gl.createTexture();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    if (sizeChanged) {
      this.videoSize = [vw, vh];
      this._syncOutputSize();
    }

    // 每帧重置命名表：MAIN/NATIVE 指向视频帧，其余 pass 重建
    this.textureMap.clear();
    this.textureMap.set('MAIN', { tex: this.videoTexture, fbo: null, w: vw, h: vh, owned: false });

    const t0 = performance.now();
    for (const pass of this.passes) this._runPass(pass);

    // 呈现：最终 MAIN → canvas（object-fit contain + Y 翻转）
    const finalTex = this.textureMap.get('MAIN');
    if (finalTex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.presentProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      const loc = gl.getAttribLocation(this.presentProgram, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, finalTex.tex);
      gl.uniform1i(this.presentUniforms.tex, 0);
      gl.uniform2f(this.presentUniforms.srcSize, finalTex.w, finalTex.h);
      gl.uniform2f(this.presentUniforms.outSize, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.presentUniforms.sharpness, this.sharpness);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // 按底层纹理去重回收，避免不同命名意外指向同一 GPU 资源。
    const released = new Set();
    for (const [name, entry] of [...this.textureMap]) {
      if (entry.owned && !released.has(entry.tex)) {
        released.add(entry.tex);
        this._releaseTarget({ tex: entry.tex, fbo: entry.fbo, w: entry.w, h: entry.h, components: entry.components || 4 });
      }
      this.textureMap.delete(name);
    }
    return performance.now() - t0;
  }

  disposePipeline() {
    const gl = this.gl;
    for (const { program } of this.programs) gl.deleteProgram(program);
    this.programs = [];
    this.passes = [];
    for (const [, entry] of this.textureMap) {
      if (entry.owned) {
        gl.deleteTexture(entry.tex);
        gl.deleteFramebuffer(entry.fbo);
      }
    }
    this.textureMap.clear();
    for (const pool of this.texturePool.values()) {
      for (const t of pool) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    this.texturePool.clear();
  }

  dispose() {
    this.disposePipeline();
    const gl = this.gl;
    if (this.videoTexture) gl.deleteTexture(this.videoTexture);
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.presentProgram) gl.deleteProgram(this.presentProgram);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
  }
}

/** 引擎工厂：加载 shader 源并构建管线（懒加载 anime4kShaders 模块） */
export async function createAnime4kPipeline(canvas, presetId, options = {}) {
  const { ANIME4K_SHADERS, ANIME4K_PRESETS } = await import('./anime4kShaders.js');
  const effectivePreset = resolveRealtimeAnime4kPreset(presetId, options.inputWidth, options.inputHeight);
  const sharpness = options.passthrough ? 0 : ({ light: 0.18, balanced: 0.28, quality: 0.38 }[presetId] ?? 0.28);
  const engine = new Anime4kEngine(canvas, { maxOutputEdge: options.maxOutputEdge || 1920, sharpness });
  engine.requestedPreset = presetId;
  engine.effectivePreset = effectivePreset;
  // 诊断直通模式：跳过全部 CNN pass，仅上传视频帧并呈现。
  // 用于花屏问题二分定位：直通正常→CNN 管线问题；直通仍花→帧上传/合成层问题。
  if (options.passthrough) {
    engine.loadPipeline([]);
    return engine;
  }
  const names = ANIME4K_PRESETS[effectivePreset] || ANIME4K_PRESETS.balanced;
  engine.loadPipeline(names.map((name) => ({ name, glsl: ANIME4K_SHADERS[name] })));
  return engine;
}
