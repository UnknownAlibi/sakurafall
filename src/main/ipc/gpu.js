// GPU 合成开关 IPC（设置页「GPU 合成」）。
//
// Chromium 的 disable-gpu-compositing 只能在 app ready 前决定，所以这里只负责
// 读写偏好文件；切换后必须重启应用才生效，由渲染层提示并调用 app-relaunch。
const {
    readGpuCompositingPreference,
    writeGpuCompositingPreference,
    isGpuCompositingForcedByEnv
} = require('../utils/gpuCompositingPreference');

/** 当前实际是否走 GPU（硬件）合成；GpuGuard 降级时同样返回 false。 */
function isHardwareCompositing(app) {
    try {
        const status = String(app.getGPUFeatureStatus?.()?.gpu_compositing || '');
        return status.startsWith('enabled');
    } catch (_error) {
        return false;
    }
}

function registerGpuIpc({ handle, app, preferenceFile, isDev }) {
    handle('gpu-compositing-get', () => {
        // 偏好缺省时为默认值（GPU 合成 + 关闭 DirectComposition）
        const preference = readGpuCompositingPreference(preferenceFile);
        const enabled = preference !== false;
        const active = isHardwareCompositing(app);
        return {
            // 设置页开关的值（下次启动生效）
            enabled,
            // 本次进程实际的合成方式
            active,
            // 开关值与当前实际状态不一致 = 需要重启
            restartRequired: enabled !== active,
            // 环境变量/启动参数已强制开启，设置页不应覆盖
            envLocked: isGpuCompositingForcedByEnv(),
            // 开发模式下不能走 app.relaunch()：npm run dev 的 --kill-others
            // 会在 Electron 退出时连带杀掉 Vite，重启后页面加载不到 dev server（白屏）
            devMode: !!isDev
        };
    });

    handle('gpu-compositing-set', (event, enabled) => {
        if (isGpuCompositingForcedByEnv()) {
            return {
                success: false,
                error: '已通过环境变量/启动参数强制开启 GPU 合成，请先移除 SAKURAFALL_GPU_COMPOSITING / --gpu-compositing'
            };
        }
        try {
            const payload = writeGpuCompositingPreference(preferenceFile, enabled === true);
            return {
                success: true,
                enabled: payload.enabled,
                restartRequired: payload.enabled !== isHardwareCompositing(app)
            };
        } catch (error) {
            return { success: false, error: error.message || '写入 GPU 合成偏好失败' };
        }
    });

    handle('app-relaunch', () => {
        if (isDev) {
            return {
                success: false,
                devMode: true,
                error: '开发模式请手动重启：结束当前 npm run dev 后重新执行（应用内重启会连带关闭 Vite，导致白屏）'
            };
        }
        // 先让 IPC 正常返回，再重启，避免渲染进程收到 Promise reject
        setTimeout(() => {
            app.relaunch();
            app.exit(0);
        }, 120);
        return { success: true };
    });
}

module.exports = { registerGpuIpc, isHardwareCompositing };
