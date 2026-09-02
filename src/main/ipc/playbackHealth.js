function logPlaybackFailure(scope, id, result = {}) {
  if (result.success !== false) return;
  const diagnostics = result.diagnostics || {};
  console.warn(`[PlaybackFail] ${scope}=${id} reason=${result.reason}`
    + ` category=${diagnostics.category || ''} type=${diagnostics.type || ''}`
    + ` details=${diagnostics.details || ''} status=${diagnostics.status || 0}`
    + ` attempts=${diagnostics.attempts || 0} error=${result.error || ''}`);
}

function registerPlaybackHealthIpc({ handle, cmsApiService, sourceProviderRegistry }) {
  handle('source-provider-report-playback', (_event, providerId, result = {}) => {
    logPlaybackFailure('provider', providerId, result);
    return sourceProviderRegistry.reportPlayback(providerId, result);
  });

  handle('cms-preheat-candidates', async (_event, candidates = []) => {
    try {
      return await cmsApiService.preheatCandidateLines(candidates);
    } catch (error) {
      console.error('[CmsApi] Candidate preheat failed:', error);
      return { preheated: 0, results: [], error: error.message };
    }
  });

  handle('cms-report-source-playback', async (_event, sourceId, result = {}) => {
    try {
      logPlaybackFailure('source', sourceId, result);
      return cmsApiService.recordPlaybackResult(sourceId, result);
    } catch (error) {
      console.error('[CmsApi] Failed to record playback health:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerPlaybackHealthIpc };
