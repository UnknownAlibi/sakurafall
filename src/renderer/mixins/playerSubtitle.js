/**
 * 播放器字幕 mixin（本地字幕文件 + OpenSubtitles 在线搜索）
 *
 * 从 VideoPlayer.vue 抽出的「字幕」职责（体积棘轮要求新代码先拆职责）：
 *  - 字幕 cue 与开关状态（subtitleCues / showSubtitle）
 *  - 在线搜索面板状态（visible / loading / results / error）
 *  - 加载/搜索/应用/关闭面板等方法
 *  - OpenSubtitles API Key 的同步（变化时 + 启动时推给主进程 SubtitleService）
 *
 * 依赖宿主组件提供：
 *  - mapGetters：enableSubtitle / openSubtitlesApiKey，以及模板里的 $refs.subtitleLayer
 *  - 组件 data：loading / error / currentTime
 */
export default {
    data() {
        return {
            // 字幕 cue 数组：[{ start, end, text }]
            subtitleCues: [],
            // 字幕开关（受设置和是否有字幕双重控制）
            showSubtitle: false,
            // 字幕搜索面板状态
            subtitleSearchVisible: false,
            subtitleSearchLoading: false,
            subtitleSearchResults: [],
            subtitleSearchError: ''
        };
    },
    computed: {
        // 是否渲染字幕层组件（仅在视频就绪时挂载）
        showSubtitleLayer() {
            return !this.loading && !this.error;
        }
    },
    watch: {
        // OpenSubtitles API Key 变化时同步到主进程
        openSubtitlesApiKey(val) {
            if (window.electronAPI?.subtitleSetApiKey) {
                window.electronAPI.subtitleSetApiKey(val || '').catch(() => {});
            }
        }
    },
    mounted() {
        // 同步字幕设置到主进程（OpenSubtitles API Key）
        // 主进程的 SubtitleService 需要此 Key 才能调用在线搜索
        if (this.openSubtitlesApiKey && window.electronAPI?.subtitleSetApiKey) {
            window.electronAPI.subtitleSetApiKey(this.openSubtitlesApiKey).catch(() => {});
        }
        // 应用设置中的字幕开关偏好
        this.showSubtitle = !!this.enableSubtitle && this.subtitleCues.length > 0;
    },
    methods: {
        toggleSubtitle() {
            if (!this.showSubtitle && this.subtitleCues.length === 0) {
                // 还没有字幕数据，提示用户加载
                this.$notify?.warning('字幕', '请先加载本地字幕或在线搜索字幕');
                return;
            }
            this.showSubtitle = !this.showSubtitle;
            // 同步到 settings store，记录用户偏好
            this.$store.dispatch('settings/updateEnableSubtitle', this.showSubtitle);
        },

        /**
         * 加载本地字幕文件（由 ControlBar 按钮触发）
         * 调用主进程弹出文件选择对话框，解析后填充字幕 cue 数组
         */
        async loadSubtitleFile() {
            try {
                const result = await window.electronAPI.subtitleParseFile();
                if (!result || result.canceled) return;
                if (!result.success) {
                    this.$notify?.error('字幕加载失败', result.error || '未知错误');
                    return;
                }
                this.onSubtitleLoaded(result.cues, result.format);
            } catch (e) {
                console.error('[VideoPlayer] 加载字幕失败:', e);
                this.$notify?.error('字幕加载失败', e.message || '未知错误');
            }
        },

        /**
         * 字幕加载完成后的统一处理
         * @param {Array} cues - 字幕 cue 数组
         * @param {string} [format] - 字幕格式（srt/vtt/ass）
         */
        onSubtitleLoaded(cues, format) {
            const count = Array.isArray(cues) ? cues.length : 0;
            if (count === 0) {
                this.$notify?.warning('字幕', '字幕文件无有效内容');
                return;
            }
            this.subtitleCues = cues;
            this.showSubtitle = true;
            // 同步到 settings store
            this.$store.dispatch('settings/updateEnableSubtitle', true);
            // 通知字幕层重置查找状态
            this.$nextTick(() => {
                if (this.$refs.subtitleLayer) {
                    this.$refs.subtitleLayer.onSeek(this.currentTime || 0);
                }
            });
            this.$notify?.success('字幕已加载', `共 ${count} 条（${format || 'srt'}）`);
        },

        /**
         * 在线搜索字幕（由 ControlBar 按钮触发）
         * 使用当前番剧名作为关键词，调用 OpenSubtitles API
         * 需要用户在设置中配置 API Key
         */
        async onSubtitleSearch() {
            const keyword = this.danmakuAnimeName;
            if (!keyword) {
                this.$notify?.warning('字幕搜索', '当前视频没有番剧信息，无法搜索');
                return;
            }
            if (!this.openSubtitlesApiKey) {
                this.$notify?.warning('字幕搜索', '请先在设置中配置 OpenSubtitles API Key');
                return;
            }

            this.subtitleSearchVisible = true;
            this.subtitleSearchLoading = true;
            this.subtitleSearchError = '';
            this.subtitleSearchResults = [];

            try {
                const result = await window.electronAPI.subtitleSearch(keyword, 'zh');
                if (!result || !result.success) {
                    this.subtitleSearchError = result?.error || '搜索失败';
                    this.$notify?.error('字幕搜索失败', this.subtitleSearchError);
                    return;
                }
                this.subtitleSearchResults = result.results || [];
                if (this.subtitleSearchResults.length === 0) {
                    this.$notify?.info('字幕搜索', '未找到匹配的字幕');
                }
            } catch (e) {
                console.error('[VideoPlayer] 在线搜索字幕失败:', e);
                this.subtitleSearchError = e.message || '未知错误';
                this.$notify?.error('字幕搜索失败', e.message || '未知错误');
            } finally {
                this.subtitleSearchLoading = false;
            }
        },

        /**
         * 下载并应用在线搜索到的字幕
         * @param {Object} item - 搜索结果项 { fileId, title, ... }
         */
        async applyOnlineSubtitle(item) {
            if (!item?.fileId) {
                this.$notify?.warning('字幕下载', '字幕条目缺少 fileId');
                return;
            }
            try {
                this.$notify?.info('字幕下载', '正在下载字幕文件...');
                const downloadResult = await window.electronAPI.subtitleDownload(item.fileId);
                if (!downloadResult || !downloadResult.success) {
                    this.$notify?.error('字幕下载失败', downloadResult?.error || '未知错误');
                    return;
                }
                // 解析下载的字幕内容
                const parseResult = await window.electronAPI.subtitleParseContent(downloadResult.content);
                if (!parseResult || !parseResult.success) {
                    this.$notify?.error('字幕解析失败', parseResult?.error || '未知错误');
                    return;
                }
                this.subtitleSearchVisible = false;
                this.onSubtitleLoaded(parseResult.cues, parseResult.format);
            } catch (e) {
                console.error('[VideoPlayer] 下载在线字幕失败:', e);
                this.$notify?.error('字幕下载失败', e.message || '未知错误');
            }
        },

        /**
         * 关闭字幕搜索面板
         */
        closeSubtitleSearchPanel() {
            this.subtitleSearchVisible = false;
        }
    }
};
