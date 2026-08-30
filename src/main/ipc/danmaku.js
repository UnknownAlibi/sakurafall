function registerDanmakuIpc({ handle, danmakuApi }) {
  handle('danmaku-set-credentials', async (_event, appId, appSecret) => {
    try {
      danmakuApi.setCredentials(appId, appSecret);
      return { ok: true };
    } catch (error) {
      console.error('[Danmaku] 设置凭证失败:', error);
      return { ok: false, msg: error.message };
    }
  });

  handle('danmaku-configure-providers', async (_event, config) => {
    try {
      return { ok: true, providers: danmakuApi.configureProviders(config || {}) };
    } catch (error) {
      console.error('[Danmaku] 更新数据源配置失败:', error);
      return { ok: false, msg: error.message, providers: danmakuApi.listProviders() };
    }
  });
  handle('danmaku-list-providers', async () => danmakuApi.listProviders());
  handle('danmaku-resolve', async (_event, context) => {
    try {
      return await danmakuApi.resolveComments(context || {});
    } catch (error) {
      console.error('[Danmaku] 多源解析失败:', error);
      return { success: false, comments: [], total: 0, sources: [], error: error.message };
    }
  });
  handle('danmaku-search-providers', async (_event, context) => {
    try { return await danmakuApi.searchProviders(context || {}); }
    catch (error) {
      console.error('[Danmaku] 多源搜索失败:', error);
      return [];
    }
  });

  // Legacy dandanplay calls remain available for old renderer bundles.
  handle('danmaku-is-ready', async () => danmakuApi.isReady());
  handle('danmaku-search', async (_event, keyword) => danmakuApi.searchAnime(keyword));
  handle('danmaku-get-comments', async (_event, episodeId) => danmakuApi.getComments(episodeId));
  handle('danmaku-parse-xml', async (_event, filePath) => {
    try { return danmakuApi.parseLocalXmlFile(filePath); }
    catch (error) {
      console.error('[Danmaku] 解析本地 XML 失败:', error);
      return [];
    }
  });
  handle('danmaku-test', async () => {
    try { return await danmakuApi.test(); }
    catch (error) { return { ok: false, msg: error.message }; }
  });
}

module.exports = { registerDanmakuIpc };
