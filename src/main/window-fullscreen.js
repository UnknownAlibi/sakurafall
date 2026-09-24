/**
 * 窗口全屏管理：播放器/主窗口的全屏切换、状态同步与显示兼容性开关。
 *
 * 从 index.js 抽离的职责（棘轮预算要求新代码先拆职责）：
 *  - applyFullscreenCompatFlags()：GPU 合成兼容性开关（须在 app ready 前调用）
 *  - registerWindowFullscreenIpc(secureIpcHandle)：全屏切换/查询 IPC
 *  - bindFullscreenStateSync(win)：窗口全屏状态推送给渲染层 + 过渡期重绘与几何校正
 */
const { app, BrowserWindow, screen } = require('electron');

/**
 * 全屏显示兼容性开关（必须在 app ready 之前调用）。
 *
 * 禁用 GPU 合成（页面画布改走软件合成路径）。
 * 原因：Windows 11 24H2+ 的 DWM/MPO 合成器 + 混合显卡（AMD 核显/独显）组合下，
 * GPU 合成的窗口表面在进入全屏后可能被 DWM 冻结——视频 overlay 平面仍能刷新，
 * 但页面画布（控制栏、黑边等 UI）不再被呈现到屏幕。表现为：
 *   · 暂停时全屏，视频下方露出一片空白（视频贴顶、下方未重绘区域露底）
 *   · 播放时进全屏闪一下
 *   · 全屏后无论怎么移动鼠标，底部控制栏都不出现（DOM 层已显示，屏幕不呈现）
 * 16:9 视频因为 letterbox 偏移为 0，同样的故障不易察觉（部分片源"看起来正常"）。
 * 软件合成不经过 GPU 表面呈现链路，从根源上绕开该缺陷。
 * 视频解码/WebGL 等仍由 GPU 进程加速，代价仅在于页面合成走 CPU（1080p 播放
 * 实测 CPU 占用可接受；若后续需要，可按机型/驱动版本条件化启用）。
 */
function applyFullscreenCompatFlags() {
    app.commandLine.appendSwitch('disable-gpu-compositing');
}

/**
 * 注册窗口全屏 IPC：
 *  - window-toggle-fullscreen：切换窗口全屏并返回新状态
 *  - window-is-fullscreen：查询当前是否全屏
 *
 * 播放器全屏改由主进程切换窗口全屏，不再用 HTML5 requestFullscreen。
 * 后者会同时触发 Chromium 的 top layer 与 Electron 的窗口全屏两套机制，在无边框
 * 窗口上容易出现"点全屏闪一下"、以及窗口 bounds 与渲染视口不同步（底部/侧边
 * 留出未重绘的空白且点不动）。主进程全屏由我们自己掌控窗口尺寸，渲染层只需给
 * 播放器容器加一个铺满窗口的 class。
 * @param {(channel: string, handler: (event: unknown) => unknown) => void} secureIpcHandle
 */
function registerWindowFullscreenIpc(secureIpcHandle) {
    secureIpcHandle('window-toggle-fullscreen', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return false;
        const next = !win.isFullScreen();
        win.setFullScreen(next);
        return next;
    });

    secureIpcHandle('window-is-fullscreen', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win ? win.isFullScreen() : false;
    });
}

/**
 * 把窗口全屏状态推给渲染层，保证 Vuex 的 isFullscreen 与真实窗口状态一致
 * （用户用系统快捷键/F11 进出全屏时渲染层也能跟上）
 * @param {Electron.BrowserWindow} win
 */
function bindFullscreenStateSync(win) {
    const send = (value) => {
        if (!win.isDestroyed()) win.webContents.send('window-fullscreen-changed', value);
    };
    // 进出全屏时窗口尺寸剧变，GPU 合成器可能残留未重绘的旧表面：表现为页面 UI
    // （控制栏/黑边）不刷新、而视频层停留在旧位置——于是 2.39:1 这类需要居中
    // letterbox 偏移的视频下方会露出一片空白（16:9 视频偏移为 0 所以看不出来）。
    // 用 invalidate() 主动触发整窗重绘，覆盖过渡期间的残留表面。
    const kickRepaint = () => {
        if (win.isDestroyed()) return;
        try {
            win.webContents.invalidate();
        } catch (e) { /* 窗口销毁瞬间忽略 */ }
    };
    // 全屏几何校正：部分机器/GPU 组合下 setFullScreen 之后窗口会停在非屏幕尺寸
    // （如 (8,8,2544,1424)），四边露出桌面。等系统过渡结束后校正一次——只在尺寸
    // 确实对不上时执行，正常全屏时是空操作，不会与过渡竞争。
    const fixFullscreenBounds = () => {
        if (win.isDestroyed() || !win.isFullScreen()) return;
        try {
            const target = screen.getDisplayMatching(win.getBounds()).bounds;
            const cur = win.getBounds();
            if (cur.x !== target.x || cur.y !== target.y
                || cur.width !== target.width || cur.height !== target.height) {
                win.setBounds(target);
                kickRepaint();
            }
        } catch (e) { /* 多显示器/过渡瞬间取不到显示器时忽略 */ }
    };
    win.on('enter-full-screen', () => {
        send(true);
        kickRepaint();
        setTimeout(kickRepaint, 150);
        setTimeout(kickRepaint, 450);
        setTimeout(fixFullscreenBounds, 350);
        setTimeout(fixFullscreenBounds, 900);
    });
    win.on('leave-full-screen', () => {
        send(false);
        kickRepaint();
        setTimeout(kickRepaint, 150);
        setTimeout(kickRepaint, 450);
    });
}

module.exports = { applyFullscreenCompatFlags, registerWindowFullscreenIpc, bindFullscreenStateSync };
