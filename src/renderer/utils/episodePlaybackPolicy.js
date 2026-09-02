export const MIN_REASONABLE_EPISODE_DURATION = 45;

export function isSuspiciousSniffedMediaEnd(snapshot = {}) {
  const duration = Number(snapshot.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration >= MIN_REASONABLE_EPISODE_DURATION) {
    return false;
  }
  return String(snapshot.resolvedBy || '').toLowerCase() === 'webview-sniff';
}
