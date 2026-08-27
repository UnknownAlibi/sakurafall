const NATIVE_MEDIA_ERROR_MESSAGES = {
  1: { reason: 'native-aborted', message: '播放被中断' },
  2: { reason: 'native-network-error', message: '视频网络加载失败' },
  3: { reason: 'native-decode-error', message: '视频解码失败' },
  4: { reason: 'native-src-not-supported', message: '视频格式或地址不受支持' }
};

const HLS_DETAIL_MESSAGES = {
  manifestLoadError: 'm3u8 清单加载失败',
  manifestLoadTimeOut: 'm3u8 清单加载超时',
  manifestParsingError: 'm3u8 清单解析失败',
  levelLoadError: '清晰度列表加载失败',
  levelLoadTimeOut: '清晰度列表加载超时',
  fragLoadError: '视频分片加载失败',
  fragLoadTimeOut: '视频分片加载超时',
  fragParsingError: '视频分片解析失败',
  bufferAppendError: '视频缓冲写入失败',
  bufferStalledError: '视频缓冲停滞',
  keyLoadError: '加密密钥加载失败',
  keyLoadTimeOut: '加密密钥加载超时'
};

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function describeNativeVideoError(mediaError) {
  const code = Number(mediaError?.code) || 0;
  const mapped = NATIVE_MEDIA_ERROR_MESSAGES[code] || {
    reason: 'native-video-error',
    message: '浏览器播放器加载失败'
  };
  const extraMessage = compactText(mediaError?.message);

  return {
    source: 'native',
    code,
    reason: mapped.reason,
    message: extraMessage || mapped.message,
    userMessage: `${mapped.message}，正在尝试切换其他源`,
    hint: code === 2
      ? '可能是源站网络波动、代理/TUN 拦截或视频地址失效。'
      : '可能是视频地址格式异常、编码不兼容或源站返回了错误内容。'
  };
}

export function describeHlsError(data = {}) {
  const type = compactText(data.type) || 'unknown';
  const details = compactText(data.details) || '';
  const responseCode = Number(data.response?.code || data.response?.status || 0) || 0;
  const detailMessage = HLS_DETAIL_MESSAGES[details] || '';
  const reasonParts = ['hls', type, details || 'fatal'].filter(Boolean);

  let hint = '可能是视频源失效、源站限流或网络波动。';
  if (type.toLowerCase().includes('network') || /load|timeout/i.test(details)) {
    hint = '可能是视频源网络不通、代理/TUN 拦截、源站限流或分片地址失效。';
  } else if (type.toLowerCase().includes('media') || /buffer|decode|parsing/i.test(details)) {
    hint = '可能是媒体编码异常、分片内容损坏或播放器解码失败。';
  }

  const message = detailMessage || compactText(data.reason) || 'HLS 播放失败';
  const statusSuffix = responseCode ? ` (${responseCode})` : '';

  return {
    source: 'hls',
    type,
    details,
    responseCode,
    fatal: data.fatal === true,
    reason: reasonParts.join('-'),
    message: `${message}${statusSuffix}`,
    userMessage: `${message}${statusSuffix}，正在尝试切换其他源`,
    hint
  };
}

export function formatPlaybackFailureForDisplay(failure) {
  if (!failure) return '';
  const parts = [failure.message || failure.reason].filter(Boolean);
  if (failure.hint) parts.push(failure.hint);
  return parts.join(' ');
}

// ===== Phase 5: 失败分类系统 =====
//
// 失败类别（category）和 UI 行为：
//   invalid-source      —— 源无效（剧集缺地址、分享页解析失败、地址格式异常）
//   network-blocked     —— 网络被 TUN/VPN 拦截、DNS 失败、源站 5xx
//   cors-referer        —— 源站 403 拒绝访问（Referer/UA 校验失败）
//   hls-decode          —— hls.js 解码/网络错误（fatal）
//   format-unsupported  —— 浏览器不支持的视频格式（native code 4）
//   resolver-timeout    —— 解析超时
//   cancelled           —— 请求被新请求取代
//   unknown             —— 其他未知错误
//
// 每个分类对应：
//   - 显示标题
//   - 简要说明
//   - 建议操作（重试 / 换源 / 增强播放 / 检查网络）

const FAILURE_CATEGORY_INFO = {
  'invalid-source': {
    title: '源无效',
    description: '该源未提供可播放的视频地址，或分享页解析失败。',
    suggestion: '建议换源或重新选择剧集',
    primaryAction: 'switch-source',
    secondaryAction: 'retry'
  },
  'network-blocked': {
    title: '网络连接失败',
    description: '可能是 DNS 被劫持、TUN/VPN 拦截、源站不可达或限流。',
    suggestion: '建议检查代理设置（设置 → 代理地址）或换源',
    primaryAction: 'switch-source',
    secondaryAction: 'open-settings'
  },
  'cors-referer': {
    title: '源站拒绝访问',
    description: '源站校验 Referer/User-Agent，浏览器直连无法播放。',
    suggestion: '建议使用增强播放（mpv）或换源',
    primaryAction: 'enhanced-player',
    secondaryAction: 'switch-source'
  },
  'hls-decode': {
    title: '视频解码失败',
    description: 'hls.js 解码/分片加载异常，可能是媒体编码不兼容或分片损坏。',
    suggestion: '建议换源或使用增强播放',
    primaryAction: 'switch-source',
    secondaryAction: 'enhanced-player'
  },
  'format-unsupported': {
    title: '格式不支持',
    description: '浏览器无法播放该视频格式（如某些编码的 mp4/m3u8）。',
    suggestion: '建议使用增强播放（mpv）或换源',
    primaryAction: 'enhanced-player',
    secondaryAction: 'switch-source'
  },
  'resolver-timeout': {
    title: '解析超时',
    description: '视频地址解析超时，可能是网络不通或源站响应过慢。',
    suggestion: '建议重试或换源',
    primaryAction: 'retry',
    secondaryAction: 'switch-source'
  },
  'cancelled': {
    title: '请求已取消',
    description: '当前解析请求被新的请求取代。',
    suggestion: '请重试',
    primaryAction: 'retry',
    secondaryAction: ''
  },
  'unknown': {
    title: '播放失败',
    description: '未知错误。',
    suggestion: '请尝试重试或换源',
    primaryAction: 'retry',
    secondaryAction: 'switch-source'
  }
};

/**
 * 将任意失败对象归一化为标准分类对象
 * 优先使用 failure.category（来自 PlaybackResolverService），
 * 否则根据 failure.source / reason / code 推断
 */
export function classifyPlaybackFailure(failure) {
  if (!failure) return { category: 'unknown', ...FAILURE_CATEGORY_INFO.unknown };

  // 已经是分类过的（来自 resolver）
  if (failure.category && FAILURE_CATEGORY_INFO[failure.category]) {
    return {
      ...failure,
      ...FAILURE_CATEGORY_INFO[failure.category]
    };
  }

  // 来自 hls.js 的错误
  if (failure.source === 'hls') {
    const type = String(failure.type || '').toLowerCase();
    const details = String(failure.details || '').toLowerCase();
    if (type.includes('media') || /buffer|decode|parsing/.test(details)) {
      return { ...failure, category: 'hls-decode', ...FAILURE_CATEGORY_INFO['hls-decode'] };
    }
    if (details.includes('levelloaderror') && failure.responseCode === 403) {
      return { ...failure, category: 'cors-referer', ...FAILURE_CATEGORY_INFO['cors-referer'] };
    }
    if (type.includes('network') || /load|timeout/.test(details)) {
      return { ...failure, category: 'network-blocked', ...FAILURE_CATEGORY_INFO['network-blocked'] };
    }
    return { ...failure, category: 'hls-decode', ...FAILURE_CATEGORY_INFO['hls-decode'] };
  }

  // 来自 native video 的错误
  if (failure.source === 'native') {
    if (failure.code === 4) {
      return { ...failure, category: 'format-unsupported', ...FAILURE_CATEGORY_INFO['format-unsupported'] };
    }
    if (failure.code === 2) {
      return { ...failure, category: 'network-blocked', ...FAILURE_CATEGORY_INFO['network-blocked'] };
    }
    if (failure.code === 3) {
      return { ...failure, category: 'hls-decode', ...FAILURE_CATEGORY_INFO['hls-decode'] };
    }
    return { ...failure, category: 'unknown', ...FAILURE_CATEGORY_INFO.unknown };
  }

  // 通过 reason 字符串推断
  const reason = String(failure.reason || failure.message || '').toLowerCase();
  if (reason.includes('403') || reason.includes('forbidden')) {
    return { ...failure, category: 'cors-referer', ...FAILURE_CATEGORY_INFO['cors-referer'] };
  }
  if (reason.includes('timeout')) {
    return { ...failure, category: 'resolver-timeout', ...FAILURE_CATEGORY_INFO['resolver-timeout'] };
  }
  if (reason.includes('enotfound') || reason.includes('econnrefused') || reason.includes('network')) {
    return { ...failure, category: 'network-blocked', ...FAILURE_CATEGORY_INFO['network-blocked'] };
  }
  if (reason.includes('invalid') || reason.includes('unsupported') || reason.includes('format')) {
    return { ...failure, category: 'format-unsupported', ...FAILURE_CATEGORY_INFO['format-unsupported'] };
  }

  return { ...failure, category: 'unknown', ...FAILURE_CATEGORY_INFO.unknown };
}

/**
 * 将 hls.js 的 fatal 错误 data 转换为带分类的失败对象
 */
export function classifyHlsFailure(data, Hls) {
  const base = describeHlsError(data);
  base.attempts = base.attempts || 0;
  if (data?.type === Hls.ErrorTypes.NETWORK_ERROR) {
    base.userMessage = '视频加载失败，正在尝试自动切换其他源';
  } else if (data?.type === Hls.ErrorTypes.MEDIA_ERROR) {
    base.userMessage = '视频解码失败，正在尝试自动切换其他源';
  }
  return classifyPlaybackFailure(base);
}
