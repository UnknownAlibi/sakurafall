// 自定义包 IPC（从 main/index.js 抽离）
//   - 片源包 source-pack-*：导入/导出/列表/删除/检查更新/更新
//   - 主题包 theme-pack-*：列表/详情/删除/导入安装
// 文件对话框一律从调用窗口弹出（BrowserWindow.fromWebContents），
// 避免主窗口关闭后弹窗崩溃。

const fs = require('fs');
const { BrowserWindow, dialog } = require('electron');
const { MAX_PACK_BYTES, MAX_THEME_PACK_BYTES } = require('../services/CustomizationPackService');

function registerCustomizationPackIpc({ handle, customizationPackService, httpClient }) {
    handle('source-pack-import-file', async (event, options = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            const result = await dialog.showOpenDialog(win, {
                title: '导入片源包',
                properties: ['openFile'],
                filters: [{ name: 'SakuraFall Source Pack', extensions: ['json', 'sourcepack'] }]
            });
            if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };

            const filePath = result.filePaths[0];
            if (fs.statSync(filePath).size > MAX_PACK_BYTES) return { success: false, error: '源包超过 512KB 限制' };
            const imported = customizationPackService.importSourcePack(fs.readFileSync(filePath, 'utf8'), options);
            return { ...imported, filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    handle('source-pack-export-file', async (event, metadata = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            const exported = customizationPackService.exportSourcePack(metadata);
            const result = await dialog.showSaveDialog(win, {
                title: '导出片源包',
                defaultPath: `${exported.pack.metadata.id}.sourcepack.json`,
                filters: [{ name: 'SakuraFall Source Pack', extensions: ['json'] }]
            });
            if (result.canceled || !result.filePath) return { success: false, canceled: true };
            fs.writeFileSync(result.filePath, exported.json, 'utf8');
            return { success: true, filePath: result.filePath, count: exported.count };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    handle('source-pack-list', () => customizationPackService.listSourcePacks());
    handle('source-pack-get', (_event, id) => customizationPackService.getSourcePack(id));
    handle('source-pack-remove', (_event, id) => customizationPackService.removeSourcePack(id));

    handle('source-pack-check-updates', async () => {
        const targets = customizationPackService.getSourcePackUpdateTargets();
        return Promise.all(targets.map(async target => {
            try {
                const text = await httpClient.fetch(target.updateUrl, { charset: 'utf8' });
                const remote = customizationPackService.validateSourcePack(text);
                if (remote.metadata.id !== target.id) throw new Error('远程源包 id 与已安装包不一致');
                return {
                    ...target,
                    latestVersion: remote.metadata.version,
                    updateAvailable: customizationPackService.isNewerVersion(remote.metadata.version, target.version),
                    error: ''
                };
            } catch (error) {
                return { ...target, latestVersion: target.version, updateAvailable: false, error: error.message };
            }
        }));
    });

    handle('source-pack-update', async (_event, id) => {
        const current = customizationPackService.getSourcePack(id);
        if (!current?.metadata?.updateUrl) return { success: false, error: '该源包没有 updateUrl' };
        try {
            const text = await httpClient.fetch(current.metadata.updateUrl, { charset: 'utf8' });
            const remote = customizationPackService.validateSourcePack(text);
            if (remote.metadata.id !== current.metadata.id) throw new Error('远程源包 id 不一致');
            if (!customizationPackService.isNewerVersion(remote.metadata.version, current.metadata.version)) {
                return { success: true, updated: false, metadata: current.metadata };
            }
            const result = customizationPackService.importSourcePack(JSON.stringify(remote), { overwrite: true, install: true });
            return { ...result, updated: result.success === true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    handle('theme-pack-list', () => customizationPackService.listThemePacks());
    handle('theme-pack-get', (_event, id) => customizationPackService.getThemePack(id));
    handle('theme-pack-remove', (_event, id) => customizationPackService.removeThemePack(id));

    handle('theme-pack-import-file', async (event) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            const result = await dialog.showOpenDialog(win, {
                title: '安装界面主题包',
                properties: ['openFile'],
                filters: [{ name: 'SakuraFall Theme Pack', extensions: ['json', 'themepack'] }]
            });
            if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };

            const filePath = result.filePaths[0];
            if (fs.statSync(filePath).size > MAX_THEME_PACK_BYTES) return { success: false, error: '主题包超过 8MB 限制' };
            const installed = customizationPackService.installThemePack(fs.readFileSync(filePath, 'utf8'));
            return { ...installed, filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerCustomizationPackIpc };