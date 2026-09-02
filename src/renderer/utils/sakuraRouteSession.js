const ROUTE_PHASES = new Set(['idle', 'probing', 'switching', 'stable', 'degraded', 'failed']);

function now() {
  return Date.now();
}

function candidateSource(candidate = {}) {
  return {
    sourceId: String(candidate.sourceId || candidate.providerId || ''),
    sourceName: String(candidate.sourceName || candidate.sourceId || candidate.providerId || '')
  };
}

export function createSakuraRouteSession(context = {}) {
  return {
    version: 1,
    id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    episodeKey: context.episodeKey || '',
    phase: 'idle',
    currentSourceId: String(context.sourceId || ''),
    currentSourceName: String(context.sourceName || ''),
    previousSourceId: '',
    candidateCount: 0,
    skippedCount: 0,
    attemptedSourceIds: [],
    switchCount: 0,
    resumedAt: 0,
    message: '',
    lastError: '',
    updatedAt: now()
  };
}

export function updateSakuraRoute(session, patch = {}) {
  const base = session?.version === 1 ? session : createSakuraRouteSession();
  const phase = ROUTE_PHASES.has(patch.phase) ? patch.phase : base.phase;
  return { ...base, ...patch, phase, updatedAt: now() };
}

export function beginRouteProbe(session) {
  return updateSakuraRoute(session, {
    phase: 'probing',
    candidateCount: 0,
    skippedCount: 0,
    message: '正在预检备用线路',
    lastError: ''
  });
}

export function completeRouteProbe(session, candidates = [], skipped = []) {
  const count = Array.isArray(candidates) ? candidates.length : 0;
  return updateSakuraRoute(session, {
    phase: count > 0 ? 'stable' : 'degraded',
    candidateCount: count,
    skippedCount: Array.isArray(skipped) ? skipped.length : 0,
    message: count > 0 ? `已预检 ${count} 条备用线路` : '暂时没有可用备用线路'
  });
}

export function beginRouteSwitch(session, candidate, resumeAt = 0) {
  const source = candidateSource(candidate);
  const attempted = new Set(session?.attemptedSourceIds || []);
  if (source.sourceId) attempted.add(source.sourceId);
  return updateSakuraRoute(session, {
    phase: 'switching',
    previousSourceId: session?.currentSourceId || '',
    attemptedSourceIds: [...attempted],
    resumedAt: Math.max(0, Number(resumeAt) || 0),
    message: `正在验证 ${source.sourceName || '候选线路'}`,
    lastError: ''
  });
}

export function markRouteStable(session, source = {}) {
  const next = candidateSource(source);
  const changed = !!next.sourceId && !!session?.currentSourceId && next.sourceId !== session.currentSourceId;
  return updateSakuraRoute(session, {
    phase: 'stable',
    currentSourceId: next.sourceId || session?.currentSourceId || '',
    currentSourceName: next.sourceName || session?.currentSourceName || '',
    switchCount: (session?.switchCount || 0) + Number(changed),
    message: changed ? '已无缝切换并恢复进度' : '当前线路稳定',
    lastError: ''
  });
}

export function failRouteAttempt(session, error, final = false) {
  return updateSakuraRoute(session, {
    phase: final ? 'failed' : 'degraded',
    message: final ? '所有候选线路均不可用' : '当前线路异常，准备切换',
    lastError: String(error?.message || error || '')
  });
}

export function describeSakuraRoute(session) {
  const phase = session?.phase || 'idle';
  const labels = {
    idle: '线路待命',
    probing: '线路预检中',
    switching: '正在无缝换线',
    stable: session?.switchCount > 0 ? '已自动换线' : '线路稳定',
    degraded: '线路波动',
    failed: '线路不可用'
  };
  return {
    phase,
    label: labels[phase],
    detail: session?.message || labels[phase],
    active: phase !== 'idle'
  };
}
