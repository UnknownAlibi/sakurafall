const MIB = 1024 * 1024;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveHlsBufferPolicy(options = {}) {
  const smoothStreaming = options.smoothStreaming !== false;
  const live = options.live === true;
  const deviceMemory = finiteNumber(options.deviceMemory, 8) || 8;
  const constrained = options.performancePressure === 'high'
    || options.saveData === true
    || deviceMemory <= 4;

  let maxBufferLength;
  let maxMaxBufferLength;
  let backBufferLength;
  let baseBufferMB;

  if (live) {
    maxBufferLength = smoothStreaming ? 18 : 12;
    maxMaxBufferLength = smoothStreaming ? 36 : 24;
    backBufferLength = 18;
    baseBufferMB = constrained ? 32 : 48;
  } else if (smoothStreaming) {
    maxBufferLength = constrained ? 36 : 60;
    maxMaxBufferLength = constrained ? 72 : 120;
    backBufferLength = constrained ? 24 : 36;
    baseBufferMB = constrained ? 48 : 96;
  } else {
    maxBufferLength = constrained ? 18 : 24;
    maxMaxBufferLength = constrained ? 42 : 60;
    backBufferLength = 24;
    baseBufferMB = constrained ? 32 : 48;
  }

  const bitrate = finiteNumber(options.bitrate, 0);
  if (bitrate > 0) {
    const estimatedMB = Math.ceil((bitrate * maxBufferLength * 1.35) / 8 / MIB);
    const maximumMB = constrained ? 64 : 128;
    baseBufferMB = clamp(Math.max(baseBufferMB, estimatedMB), 32, maximumMB);
  }

  return {
    backBufferLength,
    maxBufferLength,
    maxMaxBufferLength,
    maxBufferSize: baseBufferMB * MIB,
    maxBufferHole: smoothStreaming ? 0.8 : 0.5,
    nudgeMaxRetry: smoothStreaming ? 5 : 3,
    startFragPrefetch: smoothStreaming,
    live,
    constrained,
    bufferBudgetMB: baseBufferMB
  };
}

export function applyRuntimeHlsBufferPolicy(player, overrides = {}) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const live = overrides.live ?? player.hlsStreamLive;
  const bitrate = Number(overrides.bitrate) > 0 ? Number(overrides.bitrate) : player.hlsCurrentBitrate;
  const policy = resolveHlsBufferPolicy({
    smoothStreaming: player.smoothStreaming,
    live,
    bitrate,
    deviceMemory: navigator.deviceMemory || 8,
    saveData: connection?.saveData === true,
    performancePressure: document.documentElement.getAttribute('data-performance-pressure') || ''
  });
  player.hlsStreamLive = policy.live;
  if (Number(overrides.bitrate) > 0) player.hlsCurrentBitrate = Number(overrides.bitrate);
  player.hlsBufferPolicy = policy;
  const config = player.hls?.config;
  if (config) {
    for (const key of ['backBufferLength', 'maxBufferLength', 'maxMaxBufferLength', 'maxBufferSize',
      'maxBufferHole', 'nudgeMaxRetry', 'startFragPrefetch']) {
      config[key] = policy[key];
    }
  }
  return policy;
}

export function toHlsBufferConfig(policy) {
  const config = {};
  for (const key of ['backBufferLength', 'maxBufferLength', 'maxMaxBufferLength', 'maxBufferSize',
    'maxBufferHole', 'nudgeMaxRetry', 'startFragPrefetch']) {
    config[key] = policy[key];
  }
  return config;
}
