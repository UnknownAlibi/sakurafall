// HLS 流识别与画质档位展示（从 VideoPlayer.vue 抽离以遵守体积棘轮预算）
//   - isHlsStream：判定地址是否为 HLS（.m3u8 / format=m3u8 / 代理标记 media=hls）
//   - formatQualityLabel：把 hls.js 的 level 转成「1080p / 2500kbps / 画质N」标签

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isHlsStream(url) {
  const value = String(url || '');
  return /\.m3u8(?:[?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$)/i.test(value)
    || /[?&]media=hls(?:&|$)/i.test(value);
}

/**
 * @param {{ height?: number, bitrate?: number }} level - hls.js level
 * @param {number} index - 档位序号（无高度/码率时兜底命名）
 * @returns {string}
 */
export function formatQualityLabel(level, index) {
  if (level?.height) {
    return `${level.height}p`;
  }
  if (level?.bitrate) {
    // 无高度时用码率估算
    return `${Math.round(level.bitrate / 1000)}kbps`;
  }
  return `画质${Number(index || 0) + 1}`;
}