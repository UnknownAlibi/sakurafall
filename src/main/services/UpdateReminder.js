// 番剧更新提醒服务
// 定时遍历用户收藏的番剧，调用 CmsApiService 查询最新集数，
// 与收藏时记录的 last_episode_index 对比，发现新集数则通过系统通知提醒用户。
// 提醒记录持久化到 userData/update_reminders.json，避免重复通知与重启丢失。

const path = require('path');
const fs = require('fs');
const { app, Notification, BrowserWindow } = require('electron');

class UpdateReminder {
    constructor({ animeDb, cmsApiService, iconPath = '' } = {}) {
        this.animeDb = animeDb;
        this.cmsApiService = cmsApiService;
        this.iconPath = iconPath;

        // 持久化文件路径：放在 Electron userData 目录下
        try {
            this.userDataDir = app.getPath('userData');
        } catch (e) {
            // 非 Electron 环境（单元测试）下回退到项目根目录
            this.userDataDir = path.join(__dirname, '..', '..', '..');
        }
        this.storeFile = path.join(this.userDataDir, 'update_reminders.json');

        // 定时器与配置
        this.timer = null;
        this.intervalMs = 60 * 60 * 1000;        // 默认每小时一次
        this.minIntervalMs = 10 * 60 * 1000;     // 最小 10 分钟
        this.enabled = true;
        // 是否首次检查：首次只建立基线不通知
        // 通过 lastCheckTime 是否为 0 判断，避免引入额外状态字段
        this.firstRun = true;

        // 持久化数据结构
        this.data = {
            // 未读 / 已读提醒列表（最新的在前）
            reminders: [],
            // 已通知过的集数映射 "source:animeId" -> last notified episode_index
            notifiedSet: {},
            // 首次检查基线 "source:animeId" -> first-seen episode_index
            baseline: {},
            // 上次检查时间戳（毫秒）
            lastCheckTime: 0
        };

        this._load();
    }

    // ── 持久化 ──────────────────────────────────────────

    _load() {
        try {
            if (fs.existsSync(this.storeFile)) {
                const raw = fs.readFileSync(this.storeFile, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    this.data = {
                        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
                        notifiedSet: parsed.notifiedSet && typeof parsed.notifiedSet === 'object' ? parsed.notifiedSet : {},
                        baseline: parsed.baseline && typeof parsed.baseline === 'object' ? parsed.baseline : {},
                        lastCheckTime: Number(parsed.lastCheckTime) || 0
                    };
                    this.firstRun = !this.data.lastCheckTime;
                }
            }
        } catch (e) {
            console.error('[UpdateReminder] 加载持久化数据失败:', e.message);
        }
    }

    _save() {
        try {
            fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
            fs.writeFileSync(this.storeFile, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error('[UpdateReminder] 持久化失败:', e.message);
        }
    }

    // ── 定时调度 ────────────────────────────────────────

    /**
     * 启动定时检查
     */
    start() {
        this.stop();
        if (!this.enabled) return;
        this.timer = setInterval(() => {
            this.checkNow().catch(e => {
                console.error('[UpdateReminder] 定时检查失败:', e.message);
            });
        }, this.intervalMs);
        // 不阻止进程退出
        if (this.timer.unref) this.timer.unref();
    }

    /**
     * 停止定时检查
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * 应用配置（启用/禁用、检查间隔）
     * @param {Object} options - { enabled?: boolean, intervalMinutes?: number }
     */
    configure({ enabled, intervalMinutes } = {}) {
        if (typeof enabled === 'boolean') {
            this.enabled = enabled;
        }
        if (typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)) {
            // 最小 10 分钟，防止过于频繁
            const minutes = Math.max(10, Math.floor(intervalMinutes));
            this.intervalMs = minutes * 60 * 1000;
        }
        if (this.enabled) {
            this.start();
        } else {
            this.stop();
        }
    }

    // ── 检查逻辑 ────────────────────────────────────────

    /**
     * 统计某部番剧当前的最高集数下标
     * detail.episodes 结构: { lineName: [{ title, url, ... }, ...] }
     * @returns {number} 最高集数下标，无数据返回 -1
     */
    _maxEpisodeIndex(detail) {
        if (!detail || !detail.episodes) return -1;
        let max = -1;
        for (const arr of Object.values(detail.episodes)) {
            if (!Array.isArray(arr)) continue;
            if (arr.length - 1 > max) max = arr.length - 1;
        }
        return max;
    }

    /**
     * 取指定下标的集标题
     */
    _resolveEpisodeTitle(detail, index) {
        if (!detail || !detail.episodes) return `第${index + 1}集`;
        for (const arr of Object.values(detail.episodes)) {
            if (Array.isArray(arr) && arr[index] && arr[index].title) {
                return arr[index].title;
            }
        }
        return `第${index + 1}集`;
    }

    _key(animeId, source) {
        return `${source}:${animeId}`;
    }

    /**
     * 手动触发一次检查（也可由定时器调用）
     * 用 Promise.allSettled 并发检查多个番剧，单个失败不影响其他
     */
    async checkNow() {
        if (!this.enabled) {
            return { skipped: true, reason: 'disabled' };
        }

        this.data.lastCheckTime = Date.now();

        // 拉取所有收藏（一次最多 200 条，足够覆盖普通用户）
        let favorites = [];
        try {
            const result = this.animeDb.getFavoriteList(1, 200);
            favorites = (result && result.data) || [];
        } catch (e) {
            console.error('[UpdateReminder] 获取收藏列表失败:', e.message);
            this._save();
            return { error: e.message };
        }

        if (favorites.length === 0) {
            this.firstRun = false;
            this._save();
            return { checked: 0, newReminders: [] };
        }

        // 并发检查，单个失败不阻塞其他
        const results = await Promise.allSettled(
            favorites.map(fav => this._checkOne(fav))
        );

        const newReminders = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                newReminders.push(r.value);
            }
        }

        this.firstRun = false;
        this._save();

        // 推送新提醒事件到所有窗口
        if (newReminders.length > 0) {
            this._broadcast(newReminders);
        }

        return { checked: favorites.length, newReminders };
    }

    /**
     * 检查单个番剧是否有新集数
     * @returns {Object|null} 新提醒对象，无新集数或失败返回 null
     */
    async _checkOne(fav) {
        const animeId = String(fav.anime_id);
        const source = fav.source || 'legacy';
        const key = this._key(animeId, source);
        // 收藏表中记录的已观看集数下标（-1 表示未观看）
        const recordedIndex = typeof fav.last_episode_index === 'number'
            ? fav.last_episode_index
            : -1;

        let detail = null;
        try {
            // 用 refresh 绕过详情缓存，确保拿到最新集数
            detail = await this.cmsApiService.getDetail(animeId, {
                sourceId: source,
                refresh: true
            });
        } catch (e) {
            // 单条失败静默跳过
            return null;
        }

        if (!detail || !detail.episodes) return null;

        const currentIndex = this._maxEpisodeIndex(detail);
        if (currentIndex < 0) return null;

        // 首次检查建立基线，只记录当前状态不通知
        if (this.firstRun && this.data.baseline[key] === undefined) {
            this.data.baseline[key] = currentIndex;
            this.data.notifiedSet[key] = Math.max(currentIndex, recordedIndex);
            return null;
        }

        // 已通知过该集则跳过，避免重复通知
        const lastNotified = this.data.notifiedSet[key] ?? recordedIndex;
        if (currentIndex <= lastNotified) return null;

        const episodeTitle = this._resolveEpisodeTitle(detail, currentIndex);
        const reminder = {
            id: `${key}:${currentIndex}`,
            animeId,
            source,
            name: fav.name || detail.name || '',
            cover: fav.cover || detail.cover || '',
            episodeIndex: currentIndex,
            episodeTitle,
            createdAt: Date.now(),
            read: false
        };

        // 加入提醒列表（最新的在前）
        this.data.reminders.unshift(reminder);
        // 限制提醒列表长度，避免无限增长
        if (this.data.reminders.length > 200) {
            this.data.reminders = this.data.reminders.slice(0, 200);
        }
        this.data.notifiedSet[key] = currentIndex;

        // 发送系统通知
        this._showNotification(reminder);

        return reminder;
    }

    // ── 系统通知 ────────────────────────────────────────

    _showNotification(reminder) {
        try {
            if (!Notification || typeof Notification !== 'function') return;
            const n = new Notification({
                title: '番剧更新提醒',
                body: `${reminder.name} 已更新到 ${reminder.episodeTitle}`,
                ...(this.iconPath ? { icon: this.iconPath } : {}),
                silent: false
            });
            n.on('click', () => {
                this._openAnime(reminder);
            });
            n.show();
        } catch (e) {
            console.error('[UpdateReminder] 系统通知失败:', e.message);
        }
    }

    /**
     * 通知点击后打开主窗口并跳转到该番剧
     */
    _openAnime(reminder) {
        try {
            const windows = BrowserWindow.getAllWindows();
            const main = windows.find(w => !w.isDestroyed()) || null;
            if (main) {
                if (main.isMinimized()) main.restore();
                main.show();
                main.focus();
                main.webContents.send('update-reminder-open', {
                    animeId: reminder.animeId,
                    source: reminder.source,
                    name: reminder.name
                });
            }
        } catch (e) {
            // 忽略窗口已销毁等错误
        }
    }

    /**
     * 推送新提醒事件到所有窗口（主窗口 + 播放窗口）
     */
    _broadcast(newReminders) {
        try {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                if (!win.isDestroyed()) {
                    win.webContents.send('on-update-reminder', newReminders);
                }
            }
        } catch (e) {
            // 忽略
        }
    }

    // ── 提醒列表操作 ────────────────────────────────────

    /**
     * 获取未读提醒列表 + 上次检查时间
     */
    getReminders() {
        return {
            reminders: this.data.reminders || [],
            lastCheckTime: this.data.lastCheckTime || 0
        };
    }

    /**
     * 获取未读提醒数
     */
    getUnreadCount() {
        return (this.data.reminders || []).filter(r => !r.read).length;
    }

    /**
     * 标记指定番剧的提醒为已读
     */
    markAsRead(animeId, source) {
        if (!this.data.reminders || !this.data.reminders.length) return;
        const aid = String(animeId);
        const src = String(source || 'legacy');
        let changed = false;
        this.data.reminders.forEach(r => {
            if (String(r.animeId) === aid && String(r.source) === src && !r.read) {
                r.read = true;
                changed = true;
            }
        });
        if (changed) this._save();
    }

    /**
     * 清空所有提醒
     */
    clear() {
        this.data.reminders = [];
        this._save();
    }
}

module.exports = UpdateReminder;
