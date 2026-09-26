// 元数据与目录 IPC（从 main/index.js 抽离）
//   - 本地库列表/详情/搜索（animeDb）
//   - Bangumi 在线接口（bangumiApi）
//   - SubjectService 主干（热门/时间表/季度/搜索/目录/浏览/分集）
//   - SubjectIndexService 本地索引（查询/单条/按星期/后台同步/状态）
//
// 全部为薄封装：渲染层拿到的错误结构（空列表 + error 文案）保持不变。

function registerMetadataIpc({ handle, animeDb, bangumiApi, subjectService, subjectIndexService }) {
    // ── 本地数据库 ──────────────────────────────────────────
    handle('get-anime-list', async (event, page = 1, limit = 20, search = '') => {
        try {
            return await animeDb.getAnimeList(page, limit, search);
        } catch (error) {
            console.error('获取动漫列表失败:', error);
            return { data: [], total: 0, page, limit, totalPages: 0 };
        }
    });

    handle('get-anime-detail', async (event, animeId) => {
        try {
            return await animeDb.getAnimeDetail(animeId);
        } catch (error) {
            console.error('获取动漫详情失败:', error);
            return null;
        }
    });

    handle('search-anime', async (event, keyword, limit = 10) => {
        try {
            return await animeDb.searchAnime(keyword, limit);
        } catch (error) {
            console.error('搜索动漫失败:', error);
            return [];
        }
    });

    handle('get-popular-types', async () => {
        try {
            return await animeDb.getPopularTypes();
        } catch (error) {
            console.error('获取热门分类失败:', error);
            return [];
        }
    });

    // ── Bangumi 在线数据源 ──────────────────────────────────
    handle('bangumi-get-calendar', async () => {
        try {
            return await bangumiApi.getCalendar();
        } catch (error) {
            console.error('[Bangumi] 获取季度番剧失败:', error);
            return { error: error.message };
        }
    });

    handle('bangumi-get-all', async () => {
        try {
            const animeList = await bangumiApi.getAllAnime();
            return {
                data: animeList,
                total: animeList.length,
                page: 1,
                totalPages: 1
            };
        } catch (error) {
            console.error('[Bangumi] 获取番剧列表失败:', error);
            return { data: [], total: 0, page: 1, totalPages: 0, error: error.message };
        }
    });

    handle('bangumi-get-season', async (event, year, season, page = 1) => {
        try {
            return await bangumiApi.getSeasonAnime(year, season, page);
        } catch (error) {
            console.error('[Bangumi] 获取季度番剧失败:', error);
            return { data: [], total: 0, page, totalPages: 0, year, season, error: error.message };
        }
    });

    handle('bangumi-search', async (event, keyword, page = 1) => {
        try {
            return await bangumiApi.search(keyword, page);
        } catch (error) {
            console.error('[Bangumi] 搜索失败:', error);
            return { data: [], total: 0, page, totalPages: 0, error: error.message };
        }
    });

    handle('bangumi-get-detail', async (event, bgmId) => {
        try {
            return await bangumiApi.getDetail(bgmId);
        } catch (error) {
            console.error('[Bangumi] 获取详情失败:', error);
            return null;
        }
    });

    handle('bangumi-get-characters', async (event, bgmId) => {
        try {
            return await bangumiApi.getCharacters(bgmId);
        } catch (error) {
            console.error('[Bangumi] 获取角色失败:', error);
            return [];
        }
    });

    handle('bangumi-get-aired-episode-count', async (event, bgmId) => {
        try {
            return await bangumiApi.getAiredEpisodeCount(bgmId);
        } catch (error) {
            console.error('[Bangumi] 获取已更新集数失败:', error);
            return null;
        }
    });

    handle('bangumi-get-staff', async (event, bgmId) => {
        try {
            return await bangumiApi.getStaff(bgmId);
        } catch (error) {
            console.error('[Bangumi] 获取制作人员失败:', error);
            return [];
        }
    });

    handle('bangumi-get-comments', async (event, bgmId, page = 1) => {
        try {
            return await bangumiApi.getComments(bgmId, page);
        } catch (error) {
            console.error('[Bangumi] 获取短评失败:', error);
            return { data: [], total: 0, page, totalPages: 0, error: error.message };
        }
    });

    handle('bangumi-test', async () => {
        try {
            return await bangumiApi.test();
        } catch (error) {
            console.error('[Bangumi] API 测试失败:', error);
            return { ok: false, msg: error.message };
        }
    });

    handle('bangumi-get-schedule', async () => {
        try {
            return await bangumiApi.getSchedule();
        } catch (error) {
            console.error('[Bangumi] 获取新番时间表失败:', error);
            return [];
        }
    });

    // ── SubjectService 主干 ─────────────────────────────────
    handle('subject-trending', async (event, options = {}) => {
        try {
            return await subjectService.getTrendingSubjects(options || {});
        } catch (error) {
            console.error('[Subject] 获取热门番剧失败:', error);
            return [];
        }
    });

    handle('subject-calendar', async () => {
        try {
            return await subjectService.getCalendar();
        } catch (error) {
            console.error('[Subject] 获取新番时间表失败:', error);
            return [];
        }
    });

    handle('subject-season', async (event, year, quarter, page = 1) => {
        try {
            return await subjectService.getSeason(year, quarter, page);
        } catch (error) {
            console.error('[Subject] 获取季度番剧失败:', error);
            return { data: [], total: 0, page, totalPages: 0, year, quarter, error: error.message };
        }
    });

    handle('subject-search', async (event, keyword, page = 1) => {
        try {
            return await subjectService.search(keyword, page);
        } catch (error) {
            console.error('[Subject] 搜索失败:', error);
            return { data: [], total: 0, page, totalPages: 0, error: error.message };
        }
    });

    handle('subject-catalog', async (event, options = {}) => {
        try {
            return await subjectService.catalog(options || {});
        } catch (error) {
            console.error('[Subject] 浏览目录失败:', error);
            return { data: [], total: 0, page: options?.page || 1, totalPages: 0, error: error.message };
        }
    });

    handle('subject-browse', async (event, options = {}) => {
        try {
            return await subjectService.browse(options || {});
        } catch (error) {
            console.error('[Subject] 浏览番剧失败:', error);
            return { data: [], total: 0, page: options?.page || 1, totalPages: 0, error: error.message };
        }
    });

    handle('subject-episodes', async (event, bgmId, options = {}) => {
        try {
            return await subjectService.getEpisodes(bgmId, options || {});
        } catch (error) {
            console.error('[Subject] 获取分集失败:', error);
            return { data: [], total: 0, error: error.message };
        }
    });

    // ── SubjectIndexService 本地索引 ────────────────────────
    handle('subject-index-query', async (event, filters = {}) => {
        try {
            return subjectIndexService.querySubjects(filters || {});
        } catch (error) {
            console.error('[SubjectIndex] 查询失败:', error);
            return { data: [], total: 0, page: 1, pageSize: 24, totalPages: 0, fromIndex: true, error: error.message };
        }
    });

    handle('subject-index-get', async (event, bgmId) => {
        try {
            return subjectIndexService.getSubjectByBgmId(bgmId);
        } catch (error) {
            console.error('[SubjectIndex] 获取单个失败:', error);
            return null;
        }
    });

    handle('subject-index-weekday', async (event, weekday) => {
        try {
            return subjectIndexService.queryByWeekday(weekday);
        } catch (error) {
            console.error('[SubjectIndex] 按星期查询失败:', error);
            return [];
        }
    });

    handle('subject-index-sync-season', async (event, year, season) => {
        try {
            return await subjectIndexService.syncSeason(year, season);
        } catch (error) {
            console.error('[SubjectIndex] 同步季度失败:', error);
            return { synced: 0, error: error.message };
        }
    });

    handle('subject-index-sync-calendar', async () => {
        try {
            return await subjectIndexService.syncCalendar();
        } catch (error) {
            console.error('[SubjectIndex] 同步日历失败:', error);
            return { synced: 0, error: error.message };
        }
    });

    handle('subject-index-sync-detail', async (event, bgmId) => {
        try {
            return await subjectIndexService.syncDetailIfStale(bgmId);
        } catch (error) {
            console.error('[SubjectIndex] 同步详情失败:', error);
            return null;
        }
    });

    handle('subject-index-status', async () => {
        try {
            return subjectIndexService.getSyncStatus();
        } catch (error) {
            console.error('[SubjectIndex] 获取同步状态失败:', error);
            return { indexed: 0, lastSync: {}, error: error.message };
        }
    });
}

module.exports = { registerMetadataIpc };