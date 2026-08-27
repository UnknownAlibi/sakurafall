// BT 搜索 / 边播边下 / 本地媒体库 IPC 通道注册
// 独立模块：主进程 index.js 已到体量预算上限，新增通道统一走本文件注册。

const { app } = require('electron');
const { BtStreamService } = require('../services/bt/BtStreamService');

const LOCAL_MEDIA_PACK_ID = 'local-media-library';

function buildLocalMediaPack(roots) {
  return {
    kind: 'sakurafall.source-pack',
    apiVersion: 1,
    metadata: {
      id: LOCAL_MEDIA_PACK_ID,
      name: '本地媒体库',
      version: '1.0.0',
      author: 'SakuraFall',
      description: 'BT 下载目录本地播放（在 BT 资源页添加）'
    },
    content: {
      cmsSources: [],
      xpathRules: [],
      resolvers: [],
      mediaLibraries: [
        {
          id: 'bt-local-media',
          name: '本地媒体库',
          type: 'local',
          roots: [...roots]
        }
      ]
    }
  };
}

function registerMediaLibraryIpc({ ipcMain, customizationPackService, dialog, BrowserWindow }) {
  if (!ipcMain || !customizationPackService || !dialog || !BrowserWindow) return;

  ipcMain.handle('media-library-add-local', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const picked = await dialog.showOpenDialog(win, {
        title: '选择 BT 下载目录',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths?.length) return { success: false, canceled: true };
      const folder = picked.filePaths[0];

      // 与已安装的本地媒体库合并（重复目录自动去重），保持其他媒体库不受影响
      const existing = customizationPackService.getSourcePack(LOCAL_MEDIA_PACK_ID);
      const roots = new Set([
        ...(existing?.content?.mediaLibraries?.[0]?.roots || []),
        folder
      ]);
      if (roots.size > 12) {
        return { success: false, error: '本地媒体库最多关联 12 个目录，请先在源管理中整理' };
      }

      const imported = customizationPackService.importSourcePack(buildLocalMediaPack(roots), { overwrite: true });
      return { ...imported, folder, roots: [...roots] };
    } catch (error) {
      return { success: false, error: error?.message || '添加本地媒体库失败' };
    }
  });
}

function registerBtStreamIpc({ ipcMain, streamService }) {
  ipcMain.handle('bt-stream-prepare', async (_event, magnet) => {
    try {
      const info = await streamService.prepare(String(magnet || ''));
      return { success: true, ...info };
    } catch (error) {
      return { success: false, error: error?.message || '准备边播边下失败' };
    }
  });

  ipcMain.handle('bt-stream-cache-info', () => {
    try {
      return { success: true, info: streamService.getCacheInfo() };
    } catch (error) {
      return { success: false, info: null, error: error?.message || '' };
    }
  });

  ipcMain.handle('bt-stream-clear-cache', async () => {
    try {
      return await streamService.clearCache();
    } catch (error) {
      return { success: false, error: error?.message || '清空缓存失败' };
    }
  });

  ipcMain.handle('bt-stream-open', async (_event, magnet, filePath) => {
    try {
      const stream = await streamService.open(String(magnet || ''), String(filePath || ''));
      return { success: true, ...stream };
    } catch (error) {
      return { success: false, error: error?.message || '打开播放失败' };
    }
  });

  ipcMain.handle('bt-stream-status', (_event, magnet) => {
    try {
      return { success: true, status: streamService.status(String(magnet || '')) };
    } catch (error) {
      return { success: false, status: null, error: error?.message || '' };
    }
  });

  ipcMain.handle('bt-stream-stop', async (_event, magnet) => {
    try {
      return await streamService.stop(String(magnet || ''));
    } catch (error) {
      return { success: false, error: error?.message || '停止失败' };
    }
  });
}

function registerBtIpc({ ipcMain, btSearchService, customizationPackService, dialog, BrowserWindow }) {
  if (!ipcMain || !btSearchService) return { btStreamService: null };

  ipcMain.handle('bt-search', async (_event, keyword, options) => {
    const query = String(keyword || '').trim();
    if (!query || query.length < 2) {
      return { items: [], errors: [{ provider: 'input', providerName: '输入', message: '关键词至少 2 个字符' }] };
    }
    if (query.length > 80) {
      return { items: [], errors: [{ provider: 'input', providerName: '输入', message: '关键词过长' }] };
    }

    const providers = Array.isArray(options?.providers)
      ? options.providers.filter(p => p === 'mikan' || p === 'dmhy')
      : undefined;

    try {
      return await btSearchService.search(query, { providers, limit: options?.limit });
    } catch (error) {
      return { items: [], errors: [{ provider: 'all', providerName: '全部源', message: error?.message || '搜索失败' }] };
    }
  });

  // 提前实例化并返回：主进程 applyNetworkConfig 需要调用 setProxy 把代理同步给 BT tracker
  const btStreamService = new BtStreamService({ app });
  registerBtStreamIpc({ ipcMain, streamService: btStreamService });
  registerMediaLibraryIpc({ ipcMain, customizationPackService, dialog, BrowserWindow });
  return { btStreamService };
}

module.exports = { registerBtIpc };
