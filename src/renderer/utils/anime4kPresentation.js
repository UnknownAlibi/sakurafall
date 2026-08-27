export function formatAnime4kPreset(preset) {
  return {
    light: '轻量',
    balanced: '均衡',
    quality: '画质',
    'fullscreen-safe': '全屏流畅'
  }[preset] || '均衡';
}

export function formatAnime4kBackend(status) {
  return {
    'webgpu-worker': 'WebGPU Worker',
    'webgl-main': 'WebGL 兼容',
    css: '显示增强'
  }[status?.backend] || 'GPU';
}

export function formatAnime4kRuntimeTitle(status, preset) {
  if (status?.mode === 'fullscreen-safe') {
    const reason = status?.fallbackReason ? `；原因：${status.fallbackReason}` : '';
    return `全屏流畅增强运行中；CNN 已自动降级，原视频播放不受影响${reason}`;
  }
  const effectivePreset = status?.preset || preset;
  const input = status?.inputWidth && status?.inputHeight ? `${status.inputWidth}x${status.inputHeight}` : '未知';
  const output = status?.outputWidth && status?.outputHeight ? `${status.outputWidth}x${status.outputHeight}` : '自适应';
  const adaptive = status?.adaptive
    ? `；已从${formatAnime4kPreset(preset)}档自动降为${formatAnime4kPreset(effectivePreset)}档`
    : '';
  const pipeline = status?.pipeline ? `；${status.pipeline}` : '';
  const performance = status?.renderMs
    ? `；GPU ${status.renderMs.toFixed(1)}ms/帧；丢弃 ${status.droppedFrames || 0} 帧`
    : '';
  return `Anime4K ${formatAnime4kPreset(effectivePreset)}档；${formatAnime4kBackend(status)}${pipeline}；输入 ${input}；增强输出 ${output}${performance}${adaptive}`;
}
