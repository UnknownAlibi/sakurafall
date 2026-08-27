<template>
  <div class="discovery-page">
    <PageHeader title="本周放映室" subtitle="HOT SCREENING / 热播排行与新番时间表">
      <template #icon>
        <BrandMark :size="22" />
      </template>
    </PageHeader>
    <span class="discovery-mascot" aria-hidden="true"></span>

    <!-- 加载态 -->
    <div v-if="loading" class="anime-loading-stage" aria-hidden="true">
      <div class="anime-loading-mascot"></div>
      <div class="anime-loading-bubble">
        <span>樱月正在整理热播</span>
        <i></i><i></i><i></i>
      </div>
    </div>

    <template v-else>
      <!-- 错误态：全部数据源都失败时给出重试入口，而不是伪装成"暂无数据" -->
      <div v-if="loadFailed" class="discovery-error">
        <h3>加载失败</h3>
        <p>网络不太顺畅，可能是代理未开启或数据源暂时不可达</p>
        <button class="discovery-retry-btn" @click="reload">重新加载</button>
      </div>

      <template v-else>
        <HotAnimeList :items="hotAnimeList" @view="viewAnimeDetail" />
        <BangumiSchedule :schedule="bangumiSchedule" @view="viewAnimeDetail" />

        <EmptyState
          v-if="hotAnimeList.length === 0 && bangumiSchedule.length === 0"
          title="这周还没有新发现 (´-ω-`)"
          message="数据源暂时安静，稍后再来看看吧"
          compact
        />
      </template>
    </template>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import HotAnimeList from '../components/AnimeZone/HotAnimeList.vue';
import BangumiSchedule from '../components/AnimeZone/BangumiSchedule.vue';
import BrandMark from '../components/Common/BrandMark.vue';
import PageHeader from '../components/Common/PageHeader.vue';
import EmptyState from '../components/Common/EmptyState.vue';

export default {
  name: 'Discovery',
  components: { HotAnimeList, BangumiSchedule, BrandMark, PageHeader, EmptyState },
  data() {
    return {
      trendingList: [],
      loading: true,
      // 全部数据源加载都失败时置 true，展示错误态 + 重试
      loadFailed: false
    };
  },
  computed: {
    ...mapGetters('anime', ['bangumiSchedule']),
    hotAnimeList() {
      if (this.trendingList && this.trendingList.length > 0) {
        return this.trendingList;
      }
      if (!this.bangumiSchedule || this.bangumiSchedule.length === 0) return [];
      const all = [];
      this.bangumiSchedule.forEach(day => {
        (day.items || []).forEach(item => {
          if (item.rating && item.rating > 0) all.push(item);
        });
      });
      all.sort((a, b) => b.rating - a.rating || (a.rank || 999) - (b.rank || 999));
      return all.slice(0, 12);
    }
  },
  async mounted() {
    await this.reload();
  },
  methods: {
    ...mapActions('anime', ['fetchBangumiSchedule']),

    /** 拉取热播与新番表；全部失败时标记 loadFailed 供错误态展示 */
    async reload() {
      this.loading = true;
      this.loadFailed = false;
      const results = [];
      const tasks = [];
      if (window.electronAPI?.subjectTrending) {
        tasks.push(
          window.electronAPI.subjectTrending({ limit: 12 })
            .then(list => {
              this.trendingList = Array.isArray(list) ? list : [];
              results.push(this.trendingList.length > 0);
            })
            .catch(() => {
              this.trendingList = [];
              results.push(false);
            })
        );
      }
      tasks.push(this.fetchBangumiSchedule()
        .then(() => results.push(true))
        .catch(() => results.push(false)));
      try {
        await Promise.all(tasks);
      } finally {
        this.loading = false;
      }
      // 至少有一个请求成功且拿到了数据才算正常；全失败 → 错误态
      this.loadFailed = results.length > 0 && results.every(ok => !ok);
    },
    /**
     * 点卡片：跳到动漫专区并打开详情弹窗（复用 AnimeZone 的 openAnimeDetail 机制）。
     */
    viewAnimeDetail(anime) {
      if (!anime) return;
      this.$router.push({
        name: 'anime-zone',
        query: { returnTo: 'discovery', openAnimeDetail: JSON.stringify(anime) }
      });
    }
  }
};
</script>

<style scoped>
.discovery-page {
  max-width: 1640px;
  padding: 0 28px 36px;
  margin: 0 auto;
  min-height: 100vh;
  position: relative;
}

.discovery-mascot {
  display: block;
  background: var(--sakurafall-empty-state-image) center / contain no-repeat;
  position: absolute;
  right: 40px;
  bottom: -50px;
  width: 132px;
  height: 148px;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 5px 7px rgba(29, 33, 84, 0.1));
}

[data-ui-effects="performance"] .discovery-mascot {
  display: none;
}

@media (max-width: 900px) {
  .discovery-mascot {
    display: none;
  }
}

/* ── 加载失败错误态 ── */
.discovery-error {
  text-align: center;
  padding: 72px 20px 84px;
  color: var(--text-tertiary);
}

.discovery-error h3 {
  font-size: 18px;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.discovery-error p {
  margin: 0 0 20px;
  font-size: 13px;
}

.discovery-retry-btn {
  padding: 8px 26px;
  border-radius: 999px;
  border: 1px solid var(--primary-color, #fb7299);
  background: var(--primary-color, #fb7299);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  transition: transform 0.15s var(--ease-smooth), opacity 0.15s var(--ease-smooth);
}

.discovery-retry-btn:hover {
  opacity: 0.88;
}

.discovery-retry-btn:active {
  transform: scale(0.96);
}
</style>
