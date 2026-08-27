export function formatCandidateQuality(candidate) {
  const quality = candidate?.quality || {};
  if (quality.height) return `${quality.height}p`;
  if (quality.bitrate) return `${Math.round(quality.bitrate / 1000)}kbps`;
  return '未知';
}

export function formatMatchType(matchType) {
  return { index: '同集', title: '同名', number: '同序号', first: '首集' }[matchType] || '候选';
}

export function candidateHealthClass(candidate) {
  const score = Number(candidate?.healthScore);
  return {
    'health-good': score >= 80,
    'health-warn': score >= 50 && score < 80,
    'health-bad': !Number.isFinite(score) || score < 50
  };
}

export function candidateStallClass(candidate) {
  const ratio = Number(candidate?.health?.averageStallRatio) || 0;
  return {
    'health-good': ratio < 0.02,
    'health-warn': ratio >= 0.02 && ratio < 0.08,
    'health-bad': ratio >= 0.08
  };
}

export function formatCandidateStartup(candidate) {
  const value = Number(candidate?.health?.averageStartupMs) || 0;
  if (!value) return '--';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function formatCandidateRatio(value) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

export function candidateHealthTitle(candidate) {
  const health = candidate?.health || {};
  const parts = [`${health.playbackSessionCount || 0} 次真实播放样本`];
  if (health.averageDroppedFrameRatio > 0) parts.push(`丢帧 ${formatCandidateRatio(health.averageDroppedFrameRatio)}`);
  if (health.lastPlaybackAt) parts.push(`最近播放 ${new Date(health.lastPlaybackAt).toLocaleString()}`);
  return parts.join(' · ');
}
