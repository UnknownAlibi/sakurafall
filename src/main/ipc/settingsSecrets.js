// 设置页敏感项 IPC（代理 / 第三方 API Key 等）
// 渲染层不再把这些值写进 localStorage；主进程用 safeStorage 加密落盘。

function registerSettingsSecretsIpc({ handle, store }) {
    handle('settings-secrets-get', async () => {
        try {
            return { success: true, secrets: store.load() };
        } catch (error) {
            return { success: false, error: error.message, secrets: {} };
        }
    });

    handle('settings-secrets-set', async (_event, secrets) => {
        try {
            return store.save(secrets);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerSettingsSecretsIpc };
