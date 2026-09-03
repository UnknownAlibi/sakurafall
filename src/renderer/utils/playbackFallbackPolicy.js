function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function evaluatePlaybackEvidence(snapshot = {}) {
  const currentTime = Math.max(0, finiteNumber(snapshot.currentTime));
  const observedTime = Math.max(0, finiteNumber(snapshot.observedTime));
  const lastProgressAt = Math.max(0, finiteNumber(snapshot.lastProgressAt));
  const observationStartedAt = Math.max(0, finiteNumber(snapshot.observationStartedAt));
  const readyState = Math.max(0, finiteNumber(snapshot.readyState));
  const bufferAhead = Math.max(0, finiteNumber(snapshot.bufferAhead));
  const errorCode = Math.max(0, finiteNumber(snapshot.errorCode));

  const progressed = currentTime >= observedTime + 0.2;
  const progressObserved = lastProgressAt > observationStartedAt;
  const buffered = errorCode === 0 && readyState >= 3 && bufferAhead >= 0.75;
  const canContinue = snapshot.playbackIntent === true
    && snapshot.ended !== true
    && (progressed || progressObserved || buffered);

  return { progressed, progressObserved, buffered, canContinue };
}

export function shouldAutoFallback(snapshot = {}) {
  if (snapshot.playbackIntent !== true || snapshot.ended === true) return false;
  return !evaluatePlaybackEvidence(snapshot).canContinue;
}

export function hasPlaybackStartupActivity(snapshot = {}) {
  const errorCode = Math.max(0, finiteNumber(snapshot.errorCode));
  if (errorCode > 0) return false;
  const readyState = Math.max(0, finiteNumber(snapshot.readyState));
  const bufferAhead = Math.max(0, finiteNumber(snapshot.bufferAhead));
  const duration = Math.max(0, finiteNumber(snapshot.duration));
  const bufferProgress = Math.max(0, finiteNumber(snapshot.bufferProgress));
  return readyState >= 1
    || bufferAhead > 0
    || duration > 0
    || bufferProgress > 0
    || snapshot.manifestLoaded === true;
}
