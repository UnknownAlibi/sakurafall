/**
 * 窗口状态持久化（尺寸/位置/最大化）。
 *
 * 从 index.js 抽离的职责（棘轮预算要求新代码先拆职责）。
 * 注意全屏/最小化状态不入盘、恢复时按显示器工作区钳制——历史版本曾把全屏
 * bounds 落盘，导致下次启动恢复出比屏幕还大的窗口（底部/侧边漏出桌面空白）。
 */
const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const windowStateSaveTimers = new Map();

function getWindowStateFile() {
    return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
    try {
        const file = getWindowStateFile();
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.warn('[WindowState] 读取失败:', e.message);
    }
    return {};
}

function saveWindowState(key, win) {
    if (windowStateSaveTimers.has(key)) clearTimeout(windowStateSaveTimers.get(key));
    windowStateSaveTimers.set(key, setTimeout(() => {
        windowStateSaveTimers.delete(key);
        try {
            if (win.isDestroyed()) return;
            // 全屏/最小化时的 bounds 不是用户想要的窗口尺寸（屏幕尺寸、系统占位值），
            // 落盘会导致下次启动恢复出超出屏幕或跑到可视区外的窗口，直接跳过。
            if (win.isFullScreen() || win.isMinimized()) return;
            const data = loadWindowState();
            const bounds = win.getBounds();
            data[key] = {
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y,
                isMaximized: win.isMaximized()
            };
            fs.writeFileSync(getWindowStateFile(), JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.warn('[WindowState] 保存失败:', e.message);
        }
    }, 500));
}

/**
 * 应用持久化的窗口状态（尺寸/位置/最大化）
 * @param {Electron.BrowserWindow} win
 * @param {string} key - 'mainWindow' | 'playerWindow'
 * @param {object} defaults - { minWidth, minHeight }
 */
function applyWindowState(win, key, defaults = {}) {
    const state = loadWindowState()[key];
    if (!state || !Number.isFinite(state.width) || !Number.isFinite(state.height)) {
        return false;
    }
    const minWidth = defaults.minWidth || 400;
    const minHeight = defaults.minHeight || 300;
    // 历史版本会把全屏/最小化时的 bounds 落盘（比屏幕还大或为系统占位值），直接
    // 恢复会得到超出屏幕的窗口。这里按目标显示器工作区收敛尺寸、把位置拉回可视
    // 范围（至少保留 120px 可见），保证窗口既填满可用区域也跑不到屏幕外。
    const hasPosition = Number.isFinite(state.x) && Number.isFinite(state.y);
    const display = hasPosition
        ? screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height })
        : screen.getPrimaryDisplay();
    const area = display.workArea;
    const bounds = {
        width: Math.min(Math.max(minWidth, state.width), area.width),
        height: Math.min(Math.max(minHeight, state.height), area.height)
    };
    if (hasPosition) {
        const visible = 120;
        const maxX = Math.min(state.x, area.x + area.width - bounds.width);
        bounds.x = bounds.width >= area.width ? area.x : Math.max(maxX, area.x - bounds.width + visible);
        bounds.y = Math.min(Math.max(state.y, area.y), area.y + area.height - visible);
    }
    try {
        win.setBounds(bounds);
    } catch (e) { /* 多显示器场景下 x/y 可能无效，忽略 */ }
    if (state.isMaximized) {
        win.maximize();
    }
    return true;
}

/**
 * 绑定窗口尺寸/位置/最大化变更的持久化（防抖 500ms）
 */
function bindWindowStatePersistence(win, key) {
    const handler = () => {
        if (win.isDestroyed()) return;
        saveWindowState(key, win);
    };
    win.on('resize', handler);
    win.on('move', handler);
    win.on('maximize', handler);
    win.on('unmaximize', handler);
}

module.exports = { loadWindowState, saveWindowState, applyWindowState, bindWindowStatePersistence };
