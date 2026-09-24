/**
 * 主进程窗口全屏同步 mixin
 *
 * 播放器全屏由主进程 win.setFullScreen 切换（见 src/main/window-fullscreen.js），
 * 不再使用 HTML5 requestFullscreen：后者会同时触发 Chromium top layer 与窗口全屏
 * 两套机制，在无边框窗口上容易出现"点全屏闪一下"以及窗口 bounds 与渲染视口
 * 不同步（底部/侧边留出未重绘的空白）。
 *
 * 职责：
 *  - windowFullscreen / isWindowFullscreen：主进程窗口全屏状态
 *  - toggleWindowFullscreen()：乐观切换 + 主进程结果校正
 *  - bind/unbindWindowFullscreenSync()：监听主进程全屏变化并同步进 store
 *    （保证 isFullscreen 单一真源，F11/系统快捷键进出全屏时渲染层也能跟上）
 */
export default {
    data() {
        return {
            windowFullscreen: false
        };
    },
    computed: {
        // 与 store 的 isFullscreen 解耦：isFullscreen 兼容 HTML5 requestFullscreen
        // 路径，这里记录主进程窗口全屏（决定容器是否加 is-window-fullscreen 铺满类）
        isWindowFullscreen() {
            return this.windowFullscreen;
        }
    },
    methods: {
        async toggleWindowFullscreen() {
            const target = !this.windowFullscreen;
            // 乐观更新：先切本地状态让容器立刻铺满/还原，再等主进程真实结果校正
            this.windowFullscreen = target;
            this.setFullscreen(target);
            const next = await window.electronAPI.windowToggleFullscreen();
            if (!!next !== target) {
                this.windowFullscreen = !!next;
                this.setFullscreen(!!next);
            }
        },
        bindWindowFullscreenSync() {
            if (!window.electronAPI?.onWindowFullscreenChanged) return;
            this._removeFullscreenSync = window.electronAPI.onWindowFullscreenChanged((value) => {
                this.windowFullscreen = !!value;
                this.setFullscreen(!!value);
            });
            window.electronAPI.windowIsFullscreen?.().then((value) => {
                this.windowFullscreen = !!value;
                this.setFullscreen(!!value);
            }).catch(() => {});
        },
        unbindWindowFullscreenSync() {
            if (this._removeFullscreenSync) {
                this._removeFullscreenSync();
                this._removeFullscreenSync = null;
            }
        }
    }
};
