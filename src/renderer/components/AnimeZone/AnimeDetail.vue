<template>
  <transition name="modal-fade">
    <div class="anime-detail-modal" @click="handleBackdropClick">
      <div
        ref="modalContent"
        class="modal-content"
        :class="{ 'modal-dragging': modalDragging, 'modal-drag-reset': modalDragResetting }"
        :style="modalDragStyle"
        @click.stop
        @pointerdown="onModalDragStart"
        @dblclick="onModalDragReset"
        @dragstart.prevent
      >
        <!-- 影院氛围底：封面放大模糊铺底 + 暗色纱幕，营造放映厅沉浸感 -->
        <div class="cinema-backdrop" aria-hidden="true">
          <div class="cinema-backdrop-img" :style="cinemaBackdropStyle"></div>
          <div class="cinema-backdrop-veil"></div>
        </div>

        <!-- 关闭按钮 -->
        <button class="close-btn" @click="$emit('close')">
          <span class="close-icon">✕</span>
        </button>

        <transition name="episode-opening-fade">
          <div v-if="openingEpisodeKey" class="episode-opening-notice" role="status" aria-live="polite">
            <span class="loading-spinner"></span>
            <span>正在准备这一集，播放窗口已打开...</span>
          </div>
        </transition>

        <div class="modal-body" :aria-busy="anime._bgmMetaLoading ? 'true' : 'false'">
          <LoadingMascot
            v-if="anime._bgmMetaLoading"
            class="detail-loading-state"
            text="正在整理番剧资料..."
          />
          <template v-else>
          <!-- 上半部分：封面 + 信息 -->
          <div class="anime-info-section">
            <div class="anime-cover-wrapper">
              <div class="cover-glow"></div>
              <CachedImage
                class="anime-cover"
                :src="anime.cover"
                :alt="anime.name"
                cache-variant="thumbnail"
                :cache-width="360"
                data-cache-resolve="true"
                width="360"
                height="495"
                decoding="async"
                fetchpriority="high"
                @error="handleImageError"
              />
            </div>

              <div class="anime-details">
                <div class="title-row">
                <h2 class="anime-title">{{ anime.name }}</h2>
                <!-- 收藏按钮 -->
                <button
                  class="fav-btn"
                  :class="{ favorited: isFavorited }"
                  @click="$emit('toggle-fav', anime)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" :fill="isFavorited ? 'var(--primary-color)' : 'none'" stroke="var(--primary-color)" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                  </svg>
                  <span>{{ isFavorited ? '已收藏' : '收藏' }}</span>
                  </button>
                </div>

                <!-- 信息标签 -->
                <div class="info-tags">
                <span class="info-tag" v-if="anime.year">
                  <span class="tag-icon">📅</span>{{ anime.year }}
                </span>
                <span class="info-tag" v-if="anime.area">
                  <span class="tag-icon">🌏</span>{{ anime.area }}
                </span>
                <span class="info-tag" v-if="episodeInfoText">
                  <span class="tag-icon">🎬</span>{{ episodeInfoText }}
                </span>
                <span class="info-tag" v-if="anime.rating">
                  <span class="tag-icon">⭐</span>{{ anime.rating }}
                </span>
                <span class="info-tag" v-if="anime.rank">
                  <span class="tag-icon">🏆</span>#{{ anime.rank }}
                </span>
              </div>

              <!-- 类型标签 -->
              <div class="type-tags" v-if="displayTypes.length">
                <span class="type-tag" v-for="t in displayTypes" :key="t">{{ t }}</span>
              </div>

              <!-- 简介固定放在头部，避免概览区重复并填补标题区留白。 -->
              <div class="intro-section" v-if="anime.intro">
                <p class="intro-text" :class="{ expanded: introExpanded }">{{ anime.intro }}</p>
                <button
                  v-if="anime.intro.length > 80"
                  type="button"
                  class="expand-btn"
                  :aria-expanded="String(introExpanded)"
                  @pointerdown.stop
                  @click.stop="introExpanded = !introExpanded"
                >
                  {{ introExpanded ? '收起' : '展开' }}
                  <span class="expand-arrow" :class="{ flipped: introExpanded }">▼</span>
                </button>
              </div>
            </div>
          </div>

          <!-- 选集播放区 -->
          <div class="episodes-section">
            <label v-if="!hasBangumiMeta" class="section-label">
              <span class="label-icon">📺</span>选集播放
            </label>

            <!-- 具备 Bangumi 元数据：Tab 结构（概览/选集/角色/制作/吐槽） -->
            <template v-if="hasBangumiMeta">
              <!-- Tab 导航 -->
              <div class="bgm-tabs">
                <button
                    v-for="tab in bgmTabs"
                    :key="tab.key"
                    :class="['bgm-tab', { active: activeTab === tab.key }]"
                    @click="switchTab(tab.key)"
                >
                  {{ tab.label }}
                </button>
              </div>

              <!-- Tab 内容 -->
              <div class="bgm-tab-content">
                <!-- 概览 Tab -->
                <div v-if="activeTab === 'overview'" class="bgm-overview">
                  <!-- 评分 + 评分分布 -->
                  <div v-if="anime.rating || anime.rating_total" class="rating-block">
                    <div class="rating-summary">
                      <div class="rating-score">{{ anime.rating ? Number(anime.rating).toFixed(1) : '—' }}</div>
                      <div class="rating-meta">
                        <div class="stars-row">
                          <span v-for="n in 10" :key="n" class="star" :class="{ filled: n <= Math.round(anime.rating || 0) }">★</span>
                        </div>
                        <div class="rating-count">{{ anime.rating_total || 0 }} 人评分</div>
                        <div v-if="anime.rank" class="rating-rank">排名 #{{ anime.rank }}</div>
                      </div>
                    </div>
                    <!-- 评分分布柱状图 -->
                    <div v-if="ratingHistogram.length" class="rating-histogram">
                      <div v-for="item in ratingHistogram" :key="item.star" class="hist-row">
                        <span class="hist-label">{{ item.star }}</span>
                        <div class="hist-bar-track">
                          <div class="hist-bar" :style="{ width: item.percent + '%' }"></div>
                        </div>
                        <span class="hist-count">{{ item.count }}</span>
                      </div>
                    </div>
                  </div>
                  <!-- 收藏统计 -->
                  <div v-if="collectionStats.length" class="collection-stats">
                    <div v-for="stat in collectionStats" :key="stat.label" class="stat-item">
                      <span class="stat-label">{{ stat.label }}</span>
                      <span class="stat-value">{{ stat.value }}</span>
                    </div>
                  </div>
                  <!-- Tags（带 count） -->
                  <div v-if="topTags.length" class="tags-block">
                    <div class="block-title">标签</div>
                    <div class="tags-cloud">
                      <button
                        v-for="tag in topTags"
                        :key="tag.name"
                        class="tag-chip"
                        @click="$emit('search-tag', tag.name)"
                      >
                        {{ tag.name }}
                        <span class="tag-count">{{ tag.count }}</span>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 选集 Tab -->
                <div v-else-if="activeTab === 'play'" class="bgm-play">
                  <!-- 多源播放候选区 -->
                  <div class="play-sources-section">
                    <div v-if="loadingSources" class="sources-loading">
                      <span class="loading-spinner"></span>
                      <span>正在从各资源站搜索可播放源...</span>
                    </div>

                    <!-- 资源站自带 episodes：直接显示多线路选集（无需多源候选） -->
                    <template v-else-if="displayPlaySources.length === 0 && hasEpisodes">
                      <div v-if="episodeLines.length > 1" class="line-selector">
                        <button
                          v-for="(lineId, index) in episodeLines"
                          :key="lineId"
                          :class="['line-btn', { active: currentLine === index }]"
                          @click="currentLine = index"
                        >
                          <span class="line-dot"></span>
                          {{ displayEpisodeLineName(lineId, index) }}
                        </button>
                      </div>
                      <div class="episodes-grid">
                        <button
                          v-for="(ep, i) in visibleCurrentEpisodes"
                          :key="`${currentLine}-${i}`"
                          :class="['episode-btn', {
                            active: selectedEpisode === i,
                            loading: isEpisodeOpening(ep, episodeLines[currentLine], i)
                          }]"
                          @click="onEpisodeClick(i)"
                          :disabled="!!openingEpisodeKey"
                        >
                          <span class="ep-number">{{ ep.title }}</span>
                        </button>
                      </div>
                    </template>

                    <div v-else-if="displayPlaySources.length === 0 && !backgroundSourceSearch" class="no-episodes-hint">
                      <div v-if="sourceSearchNotice" class="source-search-notice source-search-notice-empty" role="status">
                        <strong>{{ sourceSearchNotice.title }}</strong>
                        <span>{{ sourceSearchNotice.detail }}</span>
                      </div>
                      <p class="no-ep-text">{{ emptySourceMessage }}</p>
                      <button class="source-search-btn" @click="retryPlaySources">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        重新搜索播放源
                      </button>
                    </div>

                    <div v-else class="play-source-list">
                      <div v-if="backgroundSourceSearch" class="source-background-status" role="status">
                        <span class="loading-spinner"></span>
                        <span>{{ reliableSourceCount > 0 ? '可播线路已先显示，其他片源继续补充中...' : '正在继续查找其他片源和别名...' }}</span>
                      </div>
                      <div
                        v-for="source in displayPlaySources"
                        :key="source.providerId || source.sourceId"
                        :class="['play-source-card', `source-status-${source.status}`, {
                          expanded: expandedSource === playSourceIndex(source),
                          unreliable: source.status === 'success' && !source.matchReliable,
                          empty: source.status === 'success' && source.matchReliable && source.playableEpisodeCount === 0
                        }]"
                        @mousemove="onSourceCardMove"
                      >
                        <div class="source-header" @click="source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0 && toggleSourceExpand(playSourceIndex(source))">
                          <span class="source-status-dot" :class="`dot-${source.status}`"></span>
                          <span class="source-name">{{ source.sourceName }}</span>
                          <span
                            v-if="source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0"
                            :class="['source-trust-chip', sourceTrustTone(source)]"
                            :title="sourceHealthTitle(source)"
                          >
                            {{ sourceTrustLabel(source) }}
                          </span>
                          <span v-if="source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0" class="source-meta">
                            {{ source.playableEpisodeCount }}集 · 置信度 {{ Math.round(source.confidence * 100) }}%
                          </span>
                          <span v-else-if="source.status === 'success' && source.matchReliable" class="source-meta muted">分集暂不可用</span>
                          <span v-else-if="source.status === 'success'" class="source-meta muted">相似标题，未自动采用</span>
                          <span v-else-if="source.status === 'noResult'" class="source-meta muted">无结果</span>
                          <span v-else-if="source.status === 'error'" class="source-meta error" :title="source.error">失败 · {{ source.elapsedMs }}ms</span>
                          <span v-else-if="source.status === 'disabled'" class="source-meta muted">冷却中</span>
                          <span v-if="source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0" class="source-expand-icon" :class="{ open: expandedSource === playSourceIndex(source) }">▶</span>
                        </div>
                        <div v-if="expandedSource === playSourceIndex(source) && source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0" class="source-episodes">
                          <div v-if="sourceLineOptions(playSourceIndex(source)).length > 1" class="source-line-selector">
                            <span class="source-line-label">播放线路</span>
                            <button
                              v-for="(line, lineIndex) in sourceLineOptions(playSourceIndex(source))"
                              :key="line.lineId"
                              type="button"
                              :class="['source-line-btn', { active: sourceEpisodeLineId(playSourceIndex(source)) === line.lineId }]"
                              :title="line.lineId"
                              @click.stop="selectSourceLine(playSourceIndex(source), line.lineId)"
                            >
                              {{ displayEpisodeLineName(line.lineId, lineIndex) }}
                            </button>
                          </div>
                          <div class="episodes-grid">
                            <button
                              v-for="(ep, ei) in visibleSourceEpisodes(playSourceIndex(source))"
                              :key="ei"
                              :class="['episode-btn', {
                                loading: isEpisodeOpening(ep, sourceEpisodeLineId(playSourceIndex(source)), ei)
                              }]"
                              @click="onSourceEpisodeClick(playSourceIndex(source), ei)"
                              :disabled="!!openingEpisodeKey"
                            >
                              <span class="ep-number">{{ ep.title }}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 官方分集信息（只读） -->
                  <div v-if="officialEpisodes.length > 0" class="official-eps-section">
                    <label class="section-label">
                      <span class="label-icon">📋</span>官方分集信息
                    </label>
                    <div class="official-eps-list">
                      <div v-for="(ep, i) in officialEpisodes" :key="i" class="official-ep-item">
                        <span class="ep-num">第{{ ep.episode_number || i + 1 }}集</span>
                        <span class="ep-title" :title="ep.title">{{ ep.title }}</span>
                        <span v-if="ep.air_date" class="ep-date">{{ ep.air_date }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 手帐回顾 Tab：无剧透，仅显示已看进度之前的时光签 -->
                <div v-else-if="activeTab === 'notes'" class="bgm-notes">
                  <div v-if="loadingTab" class="tab-loading">
                    <span class="loading-spinner"></span>
                    <span>翻阅手帐中...</span>
                  </div>
                  <div v-else-if="workNotes.length === 0" class="tab-empty notes-empty">
                    <strong>还没有可回顾的时光签</strong>
                    <span>播放时在控制栏打开「樱月手帐」，<br/>记录台词、伏笔与名场面。</span>
                  </div>
                  <div v-else class="notes-review">
                    <p class="notes-review-hint">🔒 无剧透回顾 · 仅显示已看进度之前的记录</p>
                    <div v-for="group in groupedWorkNotes" :key="group.key" class="notes-review-group">
                      <div class="notes-review-ep">{{ group.label }}</div>
                      <div v-for="note in group.notes" :key="note.id" class="notes-review-item">
                        <span class="notes-review-time">{{ formatNoteTime(note.position) }}</span>
                        <span v-if="note.category" class="notes-review-badge" :class="`is-${note.category}`">{{ noteCategoryLabel(note.category) }}</span>
                        <span class="notes-review-text">{{ note.note || '收藏了这一刻' }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 角色 Tab -->
                <div v-else-if="activeTab === 'characters'" class="bgm-characters">
                  <div v-if="loadingTab" class="tab-loading">
                    <span class="loading-spinner"></span>
                    <span>加载角色中...</span>
                  </div>
                  <div v-else-if="characters.length === 0" class="tab-empty">暂无角色数据</div>
                  <div v-else class="characters-grid">
                    <div v-for="char in characters" :key="char.id" class="char-card">
                      <div class="char-avatar-wrap">
                        <CachedImage
                          v-if="char.images"
                          class="char-avatar"
                          :src="char.images"
                          :alt="char.name_cn || char.name"
                          cache-variant="thumbnail"
                          :cache-width="120"
                          data-cache-resolve="true"
                          width="120"
                          height="120"
                          loading="lazy"
                          decoding="async"
                          fetchpriority="low"
                          @error="onAvatarError"
                        />
                        <div v-else class="char-avatar char-avatar-placeholder">{{ (char.name_cn || char.name || '?').charAt(0) }}</div>
                      </div>
                      <div class="char-info">
                        <div class="char-name">{{ char.name_cn || char.name }}</div>
                        <div class="char-relation">{{ relationLabel(char.relation) }}</div>
                        <div v-if="char.actors && char.actors.length" class="char-actor">
                          <span class="actor-label">CV:</span>
                          <span class="actor-name">{{ char.actors[0].name_cn || char.actors[0].name }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 制作 Tab -->
                <div v-else-if="activeTab === 'staff'" class="bgm-staff">
                  <div v-if="loadingTab" class="tab-loading">
                    <span class="loading-spinner"></span>
                    <span>加载制作人员中...</span>
                  </div>
                  <div v-else-if="staff.length === 0" class="tab-empty">暂无制作人员数据</div>
                  <div v-else class="staff-list">
                    <div v-for="person in staff" :key="person.id" class="staff-card">
                      <div class="staff-avatar-wrap">
                        <CachedImage
                          v-if="person.images"
                          class="staff-avatar"
                          :src="person.images"
                          :alt="person.name_cn || person.name"
                          cache-variant="thumbnail"
                          :cache-width="160"
                          data-cache-resolve="true"
                          width="160"
                          height="160"
                          loading="lazy"
                          decoding="async"
                          fetchpriority="low"
                          @error="onAvatarError"
                        />
                        <div v-else class="staff-avatar staff-avatar-placeholder">{{ (person.name_cn || person.name || '?').charAt(0) }}</div>
                      </div>
                      <div class="staff-info">
                        <div class="staff-name">{{ person.name_cn || person.name }}</div>
                        <div class="staff-positions">
                          <span v-for="(pos, pi) in person.positions" :key="pi" class="position-tag">{{ pos }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 吐槽 Tab -->
                <div v-else-if="activeTab === 'comments'" class="bgm-comments">
                  <div v-if="loadingTab" class="tab-loading">
                    <span class="loading-spinner"></span>
                    <span>加载短评中...</span>
                  </div>
                  <div v-else-if="comments.length === 0" class="tab-empty">暂无短评</div>
                  <template v-else>
                    <div class="comments-list">
                      <div v-for="cmt in comments" :key="cmt.id" class="comment-card">
                        <div class="comment-header">
                          <CachedImage
                            v-if="cmt.user.avatar"
                            class="comment-avatar"
                            :src="cmt.user.avatar"
                            :alt="cmt.user.nickname"
                            cache-variant="thumbnail"
                            :cache-width="160"
                            data-cache-resolve="true"
                            width="160"
                            height="160"
                            loading="lazy"
                            decoding="async"
                            fetchpriority="low"
                            @error="onAvatarError"
                          />
                          <div v-else class="comment-avatar comment-avatar-placeholder">{{ (cmt.user.nickname || cmt.user.username || '?').charAt(0) }}</div>
                          <div class="comment-meta">
                            <span class="comment-user">{{ cmt.user.nickname || cmt.user.username }}</span>
                            <span v-if="cmt.rate" class="comment-rate">{{ cmt.rate }}星</span>
                          </div>
                          <span v-if="cmt.updated_at" class="comment-date">{{ formatDate(cmt.updated_at) }}</span>
                        </div>
                        <p class="comment-text">{{ cmt.comment }}</p>
                      </div>
                    </div>
                    <!-- 分页 -->
                    <div v-if="commentsPagination.totalPages > 1" class="comments-pagination">
                      <button
                        class="page-btn"
                        :disabled="commentsPagination.page <= 1"
                        @click="loadComments(commentsPagination.page - 1)"
                      >上一页</button>
                      <span class="page-info">{{ commentsPagination.page }} / {{ commentsPagination.totalPages }}</span>
                      <button
                        class="page-btn"
                        :disabled="commentsPagination.page >= commentsPagination.totalPages"
                        @click="loadComments(commentsPagination.page + 1)"
                      >下一页</button>
                    </div>
                  </template>
                </div>
              </div>
            </template>

            <!-- CMS / 非凡 来源：保持原逻辑 -->
            <template v-else>
              <!-- 有剧集：正常显示 -->
              <template v-if="hasEpisodes">
                <!-- 多线路切换 -->
                <div v-if="episodeLines.length > 1" class="line-selector">
                  <button
                    v-for="(lineId, index) in episodeLines"
                    :key="lineId"
                    :class="['line-btn', { active: currentLine === index }]"
                    @click="currentLine = index"
                  >
                    <span class="line-dot"></span>
                    {{ displayEpisodeLineName(lineId, index) }}
                  </button>
                </div>

                <!-- 剧集网格 -->
                <div class="episodes-grid">
                  <button
                    v-for="(ep, i) in visibleCurrentEpisodes"
                    :key="`${currentLine}-${i}`"
                    :class="['episode-btn', {
                      active: selectedEpisode === i,
                      loading: isEpisodeOpening(ep, episodeLines[currentLine], i)
                    }]"
                    @click="onEpisodeClick(i)"
                    :disabled="!!openingEpisodeKey"
                  >
                    <span class="ep-number">{{ ep.title }}</span>
                  </button>
                </div>
              </template>

              <!-- 无剧集：显示联动搜索按钮 -->
              <div v-else class="no-episodes-hint">
                <p class="no-ep-text">暂无播放源</p>
                <button class="source-search-btn" @click="retryPlaySources">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  重新搜索播放源
                </button>
              </div>
            </template>
          </div>
          </template>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
import CachedImage from '../Common/CachedImage.vue';
import LoadingMascot from '../Common/LoadingMascot.vue';
import { rankSourcesByMatch } from '../../utils/sourceMatch';
import { buildSourceSearchQueries, mergeSourceSearchStatuses } from '../../utils/sourceSearchQueries.js';
import { formatLineName, rankEpisodeLines } from '../../utils/episodeList.js';
import {
  plannedEpisodeCount,
  availableEpisodeCount,
  isOfficialEpisodeLine
} from '../../utils/episodeMetadata.js';

const playSourceCache = new Map();
const PLAY_SOURCE_CACHE_TTL = 30 * 60 * 1000;

function playSourceCacheKey(anime = {}) {
  const bgmId = anime.bgm_id || anime.bgmId;
  if (bgmId) return `bangumi:${bgmId}`;
  if (anime.id) return `${anime.source || anime.sourceId || 'unknown'}:${anime.id}`;
  return `title:${String(anime.name || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()}`;
}

function readPlaySourceCache(anime) {
  const key = playSourceCacheKey(anime);
  const cached = key ? playSourceCache.get(key) : null;
  if (!cached || cached.expiresAt <= Date.now()) {
    if (key) playSourceCache.delete(key);
    return null;
  }
  return cached;
}

function writePlaySourceCache(anime, sources, queries, complete = false) {
  const key = playSourceCacheKey(anime);
  const hasPlayableSource = Array.isArray(sources) && sources.some(source => (
    source.status === 'success' && source.matchReliable && Number(source.playableEpisodeCount) > 0
  ));
  if (!key || !hasPlayableSource) return;
  playSourceCache.set(key, {
    sources: JSON.parse(JSON.stringify(sources)),
    queries: queries.slice(),
    complete: complete === true,
    expiresAt: Date.now() + PLAY_SOURCE_CACHE_TTL
  });
  while (playSourceCache.size > 48) {
    playSourceCache.delete(playSourceCache.keys().next().value);
  }
}

export default {
  name: 'AnimeDetail',
  components: { CachedImage, LoadingMascot },
  props: {
    anime: {
      type: Object,
      required: true
    },
    isFavorited: {
      type: Boolean,
      default: false
    },
    openingEpisodeKey: {
      type: String,
      default: ''
    }
  },
  emits: ['close', 'play-episode', 'toggle-fav', 'search-tag', 'source-availability'],
  data() {
    return {
      introExpanded: false,
      currentLine: 0,
      selectedEpisode: null,
      // Bangumi 模式下的多源播放候选
      playSources: [],          // [{ sourceId, sourceName, animeList, episodeCount }]
      loadingSources: false,
      backgroundSourceSearch: false,
      expandedSource: -1,       // 当前展开的源 index，-1 表示都未展开
      sourceLineSelections: {},
      sourceSearchQueriesTried: [],
      sourceSearchError: '',
      // ===== Bangumi Tab 相关 =====
      activeTab: 'overview',    // overview | play | characters | staff | comments
      bgmTabs: [
        { key: 'overview', label: '概览' },
        { key: 'play', label: '选集' },
        { key: 'notes', label: '手帐' },
        { key: 'characters', label: '角色' },
        { key: 'staff', label: '制作' },
        { key: 'comments', label: '吐槽' }
      ],
      // Tab 懒加载状态：记录哪些 Tab 已加载过，避免重复请求
      tabLoaded: { overview: true, play: false, notes: false, characters: false, staff: false, comments: false },
      loadingTab: false,
      // Tab 数据
      // 手帐回顾（无剧透）：仅当前观看进度之前的时光签
      workNotes: [],
      characters: [],
      staff: [],
      comments: [],
      commentsPagination: { page: 1, totalPages: 1, total: 0 },
      visibleEpisodeLimit: 120,
      visibleSourceEpisodeLimit: 120,
      _episodeRenderFrame: null,
      _episodeRenderTimer: null,
      _sourceEpisodeRenderFrame: null,
      _sourceEpisodeRenderTimer: null,
      _sourcePrefetchTimer: null,
      _sourceSearchToken: 0,
      _playSourceLoadPromise: null,
      // Tab 数据预取：角色/制作数据用 promise 缓存，预取与切换共用同一请求
      _charactersPromise: null,
      _staffPromise: null,
      _tabPrefetchTimer: null,
      _isUnmounted: false,
      // 选集源预取状态：silent 预取进行中为 true，切换到选集 Tab 时据此显示 loading
      _playSourcePrefetching: false,
      // ===== 弹窗拖拽 =====
      dragOffsetX: 0,
      dragOffsetY: 0,
      modalDragging: false,
      modalDragResetting: false
    };
  },
  computed: {
    /**
     * 影院氛围背景：封面放大模糊铺在弹窗底层
     * （background-image 失败时自动不显示，退化为深色基底，不影响可读性）
     */
    cinemaBackdropStyle() {
      const cover = this.anime?.cover;
      return cover ? { backgroundImage: `url("${cover}")` } : { backgroundImage: 'none' };
    },
    /**
     * 弹窗拖拽位移（无位移时不加 transform，避免影响弹窗动画）
     */
    modalDragStyle() {
      if (!this.dragOffsetX && !this.dragOffsetY) return null;
      return {
        transform: `translate3d(${this.dragOffsetX}px, ${this.dragOffsetY}px, 0)`
      };
    },
    /**
     * 是否具备 Bangumi 元数据（基于 bgm_id 判断，而非 source）
     * 改造后：任何来源的番剧只要有 bgm_id 都显示完整 Bangumi 资料 Tab
     */
    hasBangumiMeta() {
      return !!this.anime.bgm_id;
    },
    /**
     * 兼容旧代码：保留 isBangumiSource 别名
     */
    isBangumiSource() {
      return this.hasBangumiMeta;
    },
    plannedEpisodeCount() {
      return plannedEpisodeCount(this.anime);
    },
    playableEpisodeCount() {
      return availableEpisodeCount(this.anime);
    },
    episodeInfoText() {
      if (this.playableEpisodeCount > 0 && this.plannedEpisodeCount > 0 && this.playableEpisodeCount < this.plannedEpisodeCount) {
        return `可播${this.playableEpisodeCount}/${this.plannedEpisodeCount}集`;
      }
      if (this.playableEpisodeCount > 0) return `可播${this.playableEpisodeCount}集`;
      if (this.plannedEpisodeCount > 0) return `计划${this.plannedEpisodeCount}集`;
      return '';
    },
    episodeLines() {
      if (!this.anime.episodes) return [];
      return rankEpisodeLines(this.anime.episodes)
        .map(line => line.lineId)
        .filter(lineId => !this.isOfficialBangumiEpisodeLine(lineId, this.anime.episodes[lineId]));
    },
    currentEpisodes() {
      if (this.episodeLines.length === 0) return [];
      const lineId = this.episodeLines[this.currentLine];
      return this.anime.episodes[lineId] || [];
    },
    // 手帐回顾按集分组
    groupedWorkNotes() {
      const groups = [];
      const map = new Map();
      for (const note of this.workNotes) {
        const ep = Number(note.episode_number);
        const key = Number.isFinite(ep) && ep > 0 ? `ep:${ep}` : `title:${note.episode_title || '未分集'}`;
        let group = map.get(key);
        if (!group) {
          group = {
            key,
            label: Number.isFinite(ep) && ep > 0
              ? `第${ep}集${note.episode_title ? ' · ' + note.episode_title : ''}`
              : (note.episode_title || '未分集'),
            notes: []
          };
          map.set(key, group);
          groups.push(group);
        }
        group.notes.push(note);
      }
      return groups;
    },
    visibleCurrentEpisodes() {
      return this.currentEpisodes.slice(0, this.visibleEpisodeLimit);
    },
    displayTypes() {
      if (!this.anime.type) return [];
      const arr = Array.isArray(this.anime.type) ? this.anime.type : [this.anime.type];
      const bigCats = ['日韩动漫','国产动漫','欧美动漫','港台动漫','海外动漫','全部动漫'];
      return arr.filter(t => t && !bigCats.includes(t));
    },
    hasEpisodes() {
      return this.episodeLines.length > 0;
    },
    /**
     * Bangumi 官方分集列表（只读展示用）
     * BangumiApi._normalizeDetail 把官方分集放在 episodes['line_1']
     */
    officialEpisodes() {
      if (!this.hasBangumiMeta) return [];
      if (Array.isArray(this.anime.official_episodes) && this.anime.official_episodes.length > 0) {
        return this.anime.official_episodes;
      }
      if (!this.anime.episodes) return [];
      const officialLine = Object.entries(this.anime.episodes)
        .find(([lineId, episodes]) => this.isOfficialBangumiEpisodeLine(lineId, episodes));
      return Array.isArray(officialLine?.[1]) ? officialLine[1] : [];
    },
    /**
     * 评分分布柱状图：从 10 分到 1 分倒序展示
     * anime.rating_histogram: { 1: count, 2: count, ..., 10: count }
     */
    ratingHistogram() {
      const histogram = this.anime.rating_histogram;
      if (!histogram || typeof histogram !== 'object') return [];
      const total = Object.values(histogram).reduce((s, c) => s + (Number(c) || 0), 0);
      if (total === 0) return [];
      const rows = [];
      for (let star = 10; star >= 1; star--) {
        const count = Number(histogram[star]) || 0;
        rows.push({
          star,
          count,
          percent: total > 0 ? Math.round((count / total) * 100) : 0
        });
      }
      return rows;
    },
    /**
     * Top 20 tags（带 count），按 count 降序
     */
    topTags() {
      const tags = this.anime.tags_with_count;
      if (!Array.isArray(tags) || tags.length === 0) return [];
      return tags
        .slice()
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, 20);
    },
    /**
     * 收藏统计：wish/collect/doing/on_hold/dropped
     */
    collectionStats() {
      const c = this.anime.collection;
      if (!c || typeof c !== 'object') return [];
      const labels = { wish: '想看', collect: '看过', doing: '在看', on_hold: '搁置', dropped: '抛弃' };
      const result = [];
      for (const key of Object.keys(labels)) {
        if (c[key] !== undefined && c[key] !== null) {
          result.push({ label: labels[key], value: c[key] });
        }
      }
      return result;
    },
    reliableSourceCount() {
      return this.playSources.filter(source => (
        source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0
      )).length;
    },
    displayPlaySources() {
      return this.playSources.filter(source => (
        source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0
      ));
    },
    sourceSearchNotice() {
      if (this.playSources.length === 0 || this.reliableSourceCount > 0) return null;
      const queryCount = this.sourceSearchQueriesTried.length;
      const hasUnreliableMatches = this.playSources.some(source => source.status === 'success' && !source.matchReliable);
      const failedCount = this.playSources.filter(source => source.status === 'error' || source.status === 'disabled').length;
      if (hasUnreliableMatches) {
        return {
          title: '找到相似标题，但没有可靠匹配',
          detail: `已尝试 ${queryCount} 个标题变体；为避免串片，没有自动采用相似结果。`
        };
      }
      if (failedCount === this.playSources.length) {
        return {
          title: '当前片源暂时不可用',
          detail: '已配置的片源均连接失败或处于冷却中，请稍后重试。'
        };
      }
      return {
        title: '已配置片源暂未收录',
        detail: `已尝试 ${queryCount} 个中文名、原名或别名；可在片源管理中添加规则后重试。`
      };
    },
    emptySourceMessage() {
      if (this.sourceSearchError) return `片源搜索失败：${this.sourceSearchError}`;
      if (this.playSources.length > 0) return '没有找到具备有效分集的播放源';
      if (this.sourceSearchQueriesTried.length > 0) return '已启用的片源暂未返回可播放分集';
      return '未找到可播放的资源站源';
    }
  },
  watch: {
    currentLine() {
      // 切换线路时重置选集
      this.selectedEpisode = null;
      this.resetVisibleEpisodeLimit();
    },
    expandedSource() {
      this.resetVisibleSourceEpisodeLimit();
    },
    // 切换不同番剧时重置多源候选状态并重新加载
    'anime.bgm_id'() {
      this.resetPlaySources();
      this.resetTabState();
      this.resetVisibleEpisodeLimit();
      this.resetVisibleSourceEpisodeLimit();
    },
    'anime.id'() {
      // 非 Bangumi 番剧切换也重置
      if (!this.hasBangumiMeta) {
        this.resetPlaySources();
      }
      this.resetVisibleEpisodeLimit();
      this.resetVisibleSourceEpisodeLimit();
    },
    'anime._bgmMetaLoading'(loading) {
      if (!loading) {
        this.scheduleTabPrefetch();
        this.schedulePlaySourcePrefetch();
      }
    }
  },
  mounted() {
    // 初次打开即为 Bangumi 番剧时，默认停留在概览 Tab，不再自动加载多源候选
    // 多源候选等用户切到"选集" Tab 时再懒加载，减少首屏网络请求
    this.resetVisibleEpisodeLimit();
    if (!this.anime._bgmMetaLoading) this.scheduleTabPrefetch();
    this.schedulePlaySourcePrefetch();
    // ESC 关闭弹窗（键盘可达性：避免用户被困在弹窗内）
    this._onEscKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.$emit('close');
      }
    };
    document.addEventListener('keydown', this._onEscKey, true);
  },
  beforeUnmount() {
    this._isUnmounted = true;
    this._sourceSearchToken += 1;
    if (this._onEscKey) {
      document.removeEventListener('keydown', this._onEscKey, true);
      this._onEscKey = null;
    }
    this.cancelPlaySourcePrefetch();
    this.cancelTabPrefetch();
    this.cancelEpisodeRender();
    this.cancelSourceEpisodeRender();
    this.stopModalDrag();
  },
  methods: {
    displayEpisodeLineName(lineId, fallbackIndex = 0) {
      return formatLineName(lineId) || `线路 ${Number(fallbackIndex) + 1}`;
    },
    /**
     * ===== 弹窗内部拖拽 =====
     * 把手 = 整个弹窗主体，排除按钮/链接/输入控件与可点选的交互区，
     * 避免误触；移动超过 3px 才真正进入拖拽，保证精确点击不受影响。
     */
    isModalDragHandle(el) {
      if (!el || !el.closest) return false;
      return !el.closest('button, a, input, textarea, select, .no-drag, .bgm-tabs, .episodes-grid, .source-episodes, .source-header, .source-line-selector, .comments-list, .comments-pagination');
    },
    onModalDragStart(event) {
      if (event.button !== 0 || this.modalDragging) return;
      if (!this.isModalDragHandle(event.target)) return;
      const el = this.$refs.modalContent;
      if (!el) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      // 还原未位移时的基准位置（rect 已包含当前 transform）
      const baseLeft = rect.left - this.dragOffsetX;
      const baseTop = rect.top - this.dragOffsetY;
      const keepVisible = 48;
      this._dragMinX = keepVisible - baseLeft - rect.width;
      this._dragMaxX = window.innerWidth - keepVisible - baseLeft;
      this._dragMinY = keepVisible - baseTop - rect.height;
      this._dragMaxY = window.innerHeight - keepVisible - baseTop;
      this._dragStartX = event.clientX;
      this._dragStartY = event.clientY;
      this._dragBaseX = this.dragOffsetX;
      this._dragBaseY = this.dragOffsetY;
      this._dragMoved = false;
      this._modalDragMove = ev => {
        const dx = ev.clientX - this._dragStartX;
        const dy = ev.clientY - this._dragStartY;
        if (!this._dragMoved) {
          if (Math.hypot(dx, dy) < 3) return;
          this._dragMoved = true;
          this.modalDragging = true;
        }
        this.dragOffsetX = Math.min(Math.max(this._dragBaseX + dx, this._dragMinX), this._dragMaxX);
        this.dragOffsetY = Math.min(Math.max(this._dragBaseY + dy, this._dragMinY), this._dragMaxY);
      };
      this._modalDragEnd = () => {
        this.stopModalDrag();
        // 拖拽结束后吞掉落点处的 click，避免误触发标签跳转等动作
        if (this._dragMoved && this.$refs.modalContent) {
          const swallow = clickEv => {
            clickEv.stopPropagation();
            clickEv.preventDefault();
          };
          const host = this.$refs.modalContent;
          host.addEventListener('click', swallow, { capture: true, once: true });
          setTimeout(() => host.removeEventListener('click', swallow, { capture: true }), 0);
        }
      };
      window.addEventListener('pointermove', this._modalDragMove);
      window.addEventListener('pointerup', this._modalDragEnd);
      window.addEventListener('pointercancel', this._modalDragEnd);
    },
    stopModalDrag() {
      if (this._modalDragMove) window.removeEventListener('pointermove', this._modalDragMove);
      if (this._modalDragEnd) {
        window.removeEventListener('pointerup', this._modalDragEnd);
        window.removeEventListener('pointercancel', this._modalDragEnd);
      }
      this._modalDragMove = null;
      this._modalDragEnd = null;
      this.modalDragging = false;
    },
    /**
     * 双击把手区域：弹窗平滑回到屏幕中央
     */
    onModalDragReset(event) {
      if (!this.isModalDragHandle(event.target)) return;
      if (!this.dragOffsetX && !this.dragOffsetY) return;
      this.modalDragResetting = true;
      this.dragOffsetX = 0;
      this.dragOffsetY = 0;
      clearTimeout(this._dragResetTimer);
      this._dragResetTimer = setTimeout(() => { this.modalDragResetting = false; }, 300);
    },

    handleBackdropClick() {
      this.$emit('close');
    },

    handleImageError(event) {
      event.target.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjI2MCIgdmlld0JveD0iMCAwIDIwMCAyNjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMjYwIiBmaWxsPSIjRjVGNUY1Ii8+CjxwYXRoIGQ9Ik0xMDAgMTMwTDEyMCAxNTBIODBMMTAwIDEzMFoiIGZpbGw9IiNDQ0MiLz4KPHRleHQgeD0iMTAwIiB5PSIxODAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMTIiPuaXoOazleWKoOi9vOWbvueJhzwvdGV4dD4KPC9zdmc+';
    },

    isOfficialBangumiEpisodeLine(lineId, episodes) {
      return isOfficialEpisodeLine(lineId, episodes);
    },

    onEpisodeClick(index) {
      if (this.openingEpisodeKey) return;
      const ep = this.currentEpisodes[index];
      if (!ep) return;

      this.selectedEpisode = index;
      this.stopBackgroundSourceSearch();
      const lineId = this.episodeLines[this.currentLine];
      this.$emit('play-episode', {
        anime: this.anime,
        episode: ep,
        episodeIndex: index,
        lineIndex: this.currentLine,
        lineId,
        requestKey: this.episodeRequestKey(ep, lineId, index)
      });
    },

    episodeRequestKey(episode, lineId, index) {
      const identity = episode?.id || episode?.url || episode?.title || index;
      return `${lineId || 'line'}:${identity}`;
    },

    isEpisodeOpening(episode, lineId, index) {
      return this.openingEpisodeKey === this.episodeRequestKey(episode, lineId, index);
    },

    /**
     * 重置多源候选状态
     */
    resetPlaySources() {
      this._sourceSearchToken += 1;
      this.currentLine = 0;
      this.playSources = [];
      this.loadingSources = false;
      this.backgroundSourceSearch = false;
      this.expandedSource = -1;
      this.sourceLineSelections = {};
      this.sourceSearchQueriesTried = [];
      this.sourceSearchError = '';
      this._playSourcePrefetching = false;
      this._playSourceLoadPromise = null;
    },

    schedulePlaySourcePrefetch() {
      this.cancelPlaySourcePrefetch();
      if (!this.hasBangumiMeta || !this.anime.name || this.tabLoaded.play || this.loadingSources) return;

      const run = () => {
        this._sourcePrefetchTimer = null;
        if (!this.hasBangumiMeta || this.tabLoaded.play || this.loadingSources) return;
        this.tabLoaded.play = true;
        this._playSourcePrefetching = true;
        // silent 预取：不显示 loading，静默在后台搜索
        const pending = this.loadPlaySources({ silent: true });
        this._playSourceLoadPromise = pending;
        pending.finally(() => {
          if (this._playSourceLoadPromise !== pending) return;
          this._playSourceLoadPromise = null;
          this._playSourcePrefetching = false;
          if (this.activeTab === 'play') this.loadingSources = false;
        });
      };

      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        this._sourcePrefetchTimer = window.requestIdleCallback(run, { timeout: 1500 });
      } else {
        this._sourcePrefetchTimer = setTimeout(run, 700);
      }
    },

    cancelPlaySourcePrefetch() {
      if (!this._sourcePrefetchTimer) return;
      if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._sourcePrefetchTimer);
      } else {
        clearTimeout(this._sourcePrefetchTimer);
      }
      this._sourcePrefetchTimer = null;
    },

    /**
     * 异步加载统一片源候选。CMS、XPath 与兼容源都通过同一个
     * SourceProvider contract 返回隔离的状态与标准化分集。
     * options.silent: 预取模式，不显示 loading 状态
     */
    async loadPlaySources(options = {}) {
      if (!this.anime.name) return;
      const sourceSearchToken = ++this._sourceSearchToken;
      const isActiveSearch = () => sourceSearchToken === this._sourceSearchToken && !this._isUnmounted;
      const snapshotIdentity = playSourceCacheKey(this.anime);
      let staleSnapshot = null;

      if (!options.refresh) {
        const cached = readPlaySourceCache(this.anime);
        if (cached) {
          this.playSources = this.decoratePlaySourceLines(cached.sources);
          this.sourceSearchQueriesTried = cached.queries;
          this.loadingSources = false;
          this.expandFirstPlayableSource();
          return;
        }
      }

      const perfMark = window.__perf?.start('source-search');
      // 用户进入选集时只看到一次统一加载态，完整源集合准备好后一次性呈现。
      if (!options.silent) this.loadingSources = true;
      this.playSources = [];
      this.backgroundSourceSearch = false;
      this.expandedSource = -1;
      this.sourceSearchQueriesTried = [];
      this.sourceSearchError = '';
      try {
        if (window.electronAPI?.sourceProviderSnapshotGet) {
          const persisted = await window.electronAPI.sourceProviderSnapshotGet(snapshotIdentity, { allowStale: true });
          if (!isActiveSearch()) return;
          if (persisted && !persisted.stale && !options.refresh) {
            this.playSources = this.decoratePlaySourceLines(persisted.sources || []);
            this.sourceSearchQueriesTried = persisted.queries || [];
            writePlaySourceCache(this.anime, this.playSources, this.sourceSearchQueriesTried, true);
            this.expandFirstPlayableSource();
            return;
          }
          staleSnapshot = persisted?.stale ? persisted : null;
        }

        const queries = buildSourceSearchQueries(this.anime, { limit: 3 });
        if (queries.length === 0) queries.push(this.anime.name);
        let freshStatuses = [];

        for (const query of queries) {
          let statusList;
          if (window.electronAPI?.sourceProviderSearchAll) {
            const reliableProviderIds = this.decoratePlaySourceLines(rankSourcesByMatch(this.anime, freshStatuses))
              .filter(source => source.status === 'success' && source.matchReliable && source.playableEpisodeCount > 0)
              .map(source => source.providerId || source.sourceId)
              .filter(Boolean);
            const unavailableProviderIds = freshStatuses
              .filter(source => source.status === 'error' || source.status === 'disabled')
              .map(source => source.providerId || source.sourceId)
              .filter(Boolean);
            const completedProviderIds = [...new Set([...reliableProviderIds, ...unavailableProviderIds])];
            statusList = await window.electronAPI.sourceProviderSearchAll(query, {
              concurrency: 4,
              hydrateLimit: 1,
              includeFallback: true,
              providerTimeoutMs: 4500,
              excludeProviderIds: completedProviderIds,
              refresh: options.refresh === true
            });
          } else if (window.electronAPI?.cmsMultiSearchAllSourcesWithStatus) {
            statusList = await window.electronAPI.cmsMultiSearchAllSourcesWithStatus(query);
          } else {
            statusList = await this.$store.dispatch('anime/searchCmsMultiAllSources', query).then(results =>
              (results || []).filter(r => r && r.data && r.data.length > 0).map(r => ({
                sourceId: r.sourceId,
                sourceName: r.sourceName || r.sourceId,
                status: 'success',
                keyword: query,
                confidence: 0.5,
                results: r.data,
                error: '',
                elapsedMs: 0
              }))
            );
          }

          if (!isActiveSearch()) return;

          freshStatuses = mergeSourceSearchStatuses(freshStatuses, statusList || []);
          this.sourceSearchQueriesTried.push(query);
        }

        // 新搜索结果在前；旧快照仅为临时超时或源站波动提供兜底。
        const completeStatuses = mergeSourceSearchStatuses(freshStatuses, staleSnapshot?.sources || []);
        const hasPlayableSources = this.applyPlaySourceStatuses(completeStatuses);
        this.expandFirstPlayableSource();
        writePlaySourceCache(this.anime, this.playSources, this.sourceSearchQueriesTried, true);
        if (hasPlayableSources && window.electronAPI?.sourceProviderSnapshotSet) {
          const sources = this.playSources.map(source => {
            const snapshotSource = { ...source };
            delete snapshotSource.rankedLines;
            return snapshotSource;
          });
          window.electronAPI.sourceProviderSnapshotSet(snapshotIdentity, {
            sources,
            queries: this.sourceSearchQueriesTried
          }).then(result => {
            if (result?.success === false) {
              console.warn('[AnimeDetail] 片源快照写入失败:', result.error || 'unknown');
            }
          }).catch(error => {
            console.warn('[AnimeDetail] 片源快照写入异常:', error?.message || error);
          });
        }
      } catch (e) {
        if (isActiveSearch() && staleSnapshot?.sources?.length) {
          this.applyPlaySourceStatuses(staleSnapshot.sources);
          this.sourceSearchQueriesTried = staleSnapshot.queries || [];
          this.expandFirstPlayableSource();
        }
        if (isActiveSearch()) this.sourceSearchError = e?.message || String(e);
        console.error('[AnimeDetail] 加载多源播放候选失败:', e);
      } finally {
        window.__perf?.end(perfMark, { sources: this.playSources.length });
        if (isActiveSearch()) this.loadingSources = false;
      }
    },

    applyPlaySourceStatuses(statuses) {
      this.playSources = this.decoratePlaySourceLines(rankSourcesByMatch(this.anime, statuses || []));
      const latestEpisodeCount = this.playSources.reduce((max, source) => (
        source.status === 'success' && source.matchReliable
          ? Math.max(max, Number(source.playableEpisodeCount) || 0)
          : max
      ), 0);
      if (latestEpisodeCount > 0) {
        this.$emit('source-availability', { id: this.anime.id, count: latestEpisodeCount });
      }
      return latestEpisodeCount > 0;
    },

    expandFirstPlayableSource() {
      const firstSuccess = this.playSources.findIndex(source => (
        source.status === 'success' && source.playableEpisodeCount > 0 && source.matchReliable
      ));
      if (firstSuccess >= 0 && this.expandedSource < 0) this.expandedSource = firstSuccess;
    },

    stopBackgroundSourceSearch() {
      this._sourceSearchToken += 1;
      this.backgroundSourceSearch = false;
    },

    retryPlaySources() {
      this.resetPlaySources();
      this.tabLoaded.play = true;
      this.loadPlaySources({ refresh: true });
    },

    /**
     * 获取指定源当前线路的剧集列表
     */
    currentSourceEpisodes(idx) {
      const lineId = this.sourceEpisodeLineId(idx);
      return this.sourceLineOptions(idx).find(line => line.lineId === lineId)?.episodes || [];
    },

    sourceEpisodeLineId(idx) {
      const source = this.playSources[idx];
      const options = this.sourceLineOptions(idx);
      const selectionKey = source?.providerId || source?.sourceId || String(idx);
      const selected = this.sourceLineSelections[selectionKey];
      return options.some(line => line.lineId === selected) ? selected : (options[0]?.lineId || '');
    },

    sourceLineOptions(idx) {
      return this.playSources[idx]?.rankedLines || [];
    },

    selectSourceLine(idx, lineId) {
      const source = this.playSources[idx];
      if (!source || !this.sourceLineOptions(idx).some(line => line.lineId === lineId)) return;
      const selectionKey = source.providerId || source.sourceId || String(idx);
      this.sourceLineSelections = { ...this.sourceLineSelections, [selectionKey]: lineId };
      this.resetVisibleSourceEpisodeLimit();
    },

    decoratePlaySourceLines(sources) {
      return (sources || []).map(source => {
        const rankedLines = rankEpisodeLines(
          source?.animeList?.[0]?.episodes || source?.results?.[0]?.episodes || {}
        );
        const playableEpisodeCount = rankedLines.reduce((max, line) => (
          Math.max(max, line.episodes.length)
        ), 0);
        return { ...source, rankedLines, playableEpisodeCount };
      });
    },

    sourceTrustLabel(source) {
      if (this.displayPlaySources[0] === source) return '优先推荐';
      const health = source?.health || {};
      if (Number(health.playbackSuccessCount) >= 3 && Number(health.playbackFailureCount) === 0) return '播放稳定';
      if (Number(health.playbackSuccessCount) > 0) return '已验证';
      return '待验证';
    },

    sourceTrustTone(source) {
      if (this.displayPlaySources[0] === source) return 'recommended';
      return Number(source?.health?.playbackSuccessCount) > 0 ? 'verified' : 'unverified';
    },

    sourceHealthTitle(source) {
      const health = source?.health || {};
      const score = Number(source?.healthScore ?? health.score ?? 70);
      const successes = Number(health.playbackSuccessCount) || 0;
      const failures = Number(health.playbackFailureCount) || 0;
      return `片源健康度 ${score}/100 · 播放成功 ${successes} 次 · 失败 ${failures} 次`;
    },

    playSourceIndex(source) {
      return this.playSources.indexOf(source);
    },

    visibleSourceEpisodes(idx) {
      return this.currentSourceEpisodes(idx).slice(0, this.visibleSourceEpisodeLimit);
    },

    resetVisibleEpisodeLimit() {
      this.cancelEpisodeRender();
      const total = this.currentEpisodes.length;
      this.visibleEpisodeLimit = Math.min(total, 120);
      if (this.visibleEpisodeLimit < total) {
        this.scheduleEpisodeRender();
      }
    },

    cancelEpisodeRender() {
      if (this._episodeRenderFrame) {
        cancelAnimationFrame(this._episodeRenderFrame);
        this._episodeRenderFrame = null;
      }
      if (this._episodeRenderTimer) {
        clearTimeout(this._episodeRenderTimer);
        this._episodeRenderTimer = null;
      }
    },

    scheduleEpisodeRender() {
      if (this._episodeRenderFrame || this._episodeRenderTimer) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const delay = pressure === 'high' ? 80 : 28;
      this._episodeRenderTimer = setTimeout(() => {
        this._episodeRenderTimer = null;
        this._episodeRenderFrame = requestAnimationFrame(() => {
          this._episodeRenderFrame = null;
          this.growVisibleEpisodes();
        });
      }, delay);
    },

    growVisibleEpisodes() {
      const total = this.currentEpisodes.length;
      if (this.visibleEpisodeLimit >= total) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const batchSize = pressure === 'high' ? 48 : 80;
      this.visibleEpisodeLimit = Math.min(total, this.visibleEpisodeLimit + batchSize);
      if (this.visibleEpisodeLimit < total) {
        this.scheduleEpisodeRender();
      }
    },

    resetVisibleSourceEpisodeLimit() {
      this.cancelSourceEpisodeRender();
      const total = this.expandedSource >= 0 ? this.currentSourceEpisodes(this.expandedSource).length : 0;
      this.visibleSourceEpisodeLimit = Math.min(total, 120);
      if (this.visibleSourceEpisodeLimit < total) {
        this.scheduleSourceEpisodeRender();
      }
    },

    cancelSourceEpisodeRender() {
      if (this._sourceEpisodeRenderFrame) {
        cancelAnimationFrame(this._sourceEpisodeRenderFrame);
        this._sourceEpisodeRenderFrame = null;
      }
      if (this._sourceEpisodeRenderTimer) {
        clearTimeout(this._sourceEpisodeRenderTimer);
        this._sourceEpisodeRenderTimer = null;
      }
    },

    scheduleSourceEpisodeRender() {
      if (this._sourceEpisodeRenderFrame || this._sourceEpisodeRenderTimer) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const delay = pressure === 'high' ? 80 : 28;
      this._sourceEpisodeRenderTimer = setTimeout(() => {
        this._sourceEpisodeRenderTimer = null;
        this._sourceEpisodeRenderFrame = requestAnimationFrame(() => {
          this._sourceEpisodeRenderFrame = null;
          this.growVisibleSourceEpisodes();
        });
      }, delay);
    },

    growVisibleSourceEpisodes() {
      const total = this.expandedSource >= 0 ? this.currentSourceEpisodes(this.expandedSource).length : 0;
      if (this.visibleSourceEpisodeLimit >= total) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const batchSize = pressure === 'high' ? 48 : 80;
      this.visibleSourceEpisodeLimit = Math.min(total, this.visibleSourceEpisodeLimit + batchSize);
      if (this.visibleSourceEpisodeLimit < total) {
        this.scheduleSourceEpisodeRender();
      }
    },

    /**
     * 切换源展开/收起
     */
    toggleSourceExpand(idx) {
      this.expandedSource = this.expandedSource === idx ? -1 : idx;
    },

    // 鼠标跟随光晕：写入光晕圆心坐标（CSS 变量驱动 radial-gradient，零布局扰动）
    onSourceCardMove(event) {
      const card = event.currentTarget;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--glow-x', `${event.clientX - rect.left}px`);
      card.style.setProperty('--glow-y', `${event.clientY - rect.top}px`);
    },

    /**
     * 点击某源的具体剧集：合并 Bangumi 元数据 + CMS 源播放信息后 emit
     * 这样播放器拿到的是可直接播放的 m3u8，同时保留了 Bangumi 的 bgm_id 用于关联
     */
    onSourceEpisodeClick(sourceIdx, epIdx) {
      if (this.openingEpisodeKey) return;
      const source = this.playSources[sourceIdx];
      if (!source || !source.animeList || source.animeList.length === 0) return;
      const sourceAnime = source.animeList[0];
      const lineId = this.sourceEpisodeLineId(sourceIdx);
      const ep = this.currentSourceEpisodes(sourceIdx)[epIdx];
      if (!ep) return;
      this.stopBackgroundSourceSearch();

      // 合并对象：Bangumi 元数据优先（封面/评分/简介/bgmid），CMS 源信息覆盖（source/id/episodes）
      const mergedAnime = {
        ...this.anime,
        source: sourceAnime.source,
        sourceId: sourceAnime.sourceId || source.sourceId,
        sourceName: sourceAnime.sourceName || source.sourceName,
        sourceType: sourceAnime.sourceType || source.sourceType || source.type,
        providerId: sourceAnime.providerId || source.providerId,
        id: sourceAnime.id,
        episodes: sourceAnime.episodes,
        episode_count: sourceAnime.episode_count,
        available_episode_count: sourceAnime.episode_count || this.playableEpisodeCount,
        planned_episode_count: this.plannedEpisodeCount,
        total_episode_count: this.plannedEpisodeCount,
        // 保留 Bangumi 的 bgm_id 用于阶段 2 的多源收藏合并
        bgm_id: this.anime.bgm_id,
        // 保留 CMS 源的 remarks 等
        remarks: sourceAnime.remarks || this.anime.remarks
      };

      this.$emit('play-episode', {
        anime: mergedAnime,
        episode: ep,
        episodeIndex: epIdx,
        lineIndex: this.sourceLineOptions(sourceIdx).findIndex(line => line.lineId === lineId),
        lineId,
        requestKey: this.episodeRequestKey(ep, lineId, epIdx)
      });
    },

    // ===== Bangumi Tab 相关方法 =====

  /**
   * 重置所有 Tab 状态（切换番剧时调用）
   */
  resetTabState() {
    this.activeTab = 'overview';
    this.tabLoaded = { overview: true, play: false, notes: false, characters: false, staff: false, comments: false };
    this.workNotes = [];
    this.loadingTab = false;
    this.characters = [];
    this.staff = [];
    this.comments = [];
    this.commentsPagination = { page: 1, totalPages: 1, total: 0 };
    this._charactersPromise = null;
    this._staffPromise = null;
    // 重新调度预取
    if (!this.anime._bgmMetaLoading) {
      this.scheduleTabPrefetch();
    }
  },

  /**
   * 后台预取角色/制作数据：用户停留在概览时静默拉取，
   * 切换到对应 Tab 时直接显示。预取与切换共用同一 promise，避免重复请求。
   */
  scheduleTabPrefetch() {
    this.cancelTabPrefetch();
    if (!this.hasBangumiMeta || !this.anime.bgm_id) return;

    const run = () => {
      this._tabPrefetchTimer = null;
      if (this._isUnmounted) return;
      // 静默预取（不触发 loadingTab）
      this.loadCharacters();
      this.loadStaff();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      this._tabPrefetchTimer = window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      this._tabPrefetchTimer = setTimeout(run, 800);
    }
  },

  cancelTabPrefetch() {
    if (!this._tabPrefetchTimer) return;
    if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this._tabPrefetchTimer);
    } else {
      clearTimeout(this._tabPrefetchTimer);
    }
    this._tabPrefetchTimer = null;
  },

  /**
   * 切换 Tab，懒加载对应数据
   */
    async switchTab(tabKey) {
    if (this.activeTab === tabKey) return;
    this.activeTab = tabKey;

    // play Tab 特殊处理：预取可能已设 tabLoaded.play=true
      if (tabKey === 'play') {
        if (this._playSourcePrefetching) {
          // 与后台预取共用同一个请求。已有结果时继续展示结果，不用整块 loading 覆盖。
          this.loadingSources = this.displayPlaySources.length === 0;
          const pending = this._playSourceLoadPromise;
          if (pending) {
            try {
              await pending;
            } finally {
              if (this.activeTab === 'play') this.loadingSources = false;
            }
          }
        } else if (!this.tabLoaded.play) {
        // 未预取过（如非 Bangumi 番剧或预取被跳过），正常加载
        this.tabLoaded.play = true;
        this.loadPlaySources();
      }
      // 否则预取已完成有数据，直接显示
      return;
    }

    // 其他 Tab：已加载过则不重复请求
    if (this.tabLoaded[tabKey]) return;

    if (tabKey === 'characters') {
      this.loadingTab = true;
      await this.loadCharacters();
      this.loadingTab = false;
    } else if (tabKey === 'notes') {
      this.loadingTab = true;
      await this.loadWorkNotes();
      this.loadingTab = false;
    } else if (tabKey === 'staff') {
      this.loadingTab = true;
      await this.loadStaff();
      this.loadingTab = false;
    } else if (tabKey === 'comments') {
      this.loadingTab = true;
      await this.loadComments(1);
      this.loadingTab = false;
    }
  },

  /**
   * 加载作品的无剧透手帐回顾（仅已看进度之前的时光签）
   */
  async loadWorkNotes() {
    try {
      const result = await window.electronAPI?.viewingNoteListSpoilerSafe?.(
        this.anime.bgm_id,
        this.anime.name || ''
      );
      this.workNotes = Array.isArray(result) ? result : [];
      this.tabLoaded.notes = true;
    } catch (e) {
      console.error('[AnimeDetail] 加载手帐回顾失败:', e);
      this.workNotes = [];
      this.tabLoaded.notes = false;
    }
  },

  formatNoteTime(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  },

  noteCategoryLabel(value) {
    const labels = { line: '台词', foreshadow: '伏笔', art: '作画', music: '音乐' };
    return labels[value] || '';
  },

  /**
   * 加载角色数据。内部用 promise 缓存实现幂等：
   * 预取与 Tab 切换共用同一请求，失败时清空 promise 允许重试。
   */
  loadCharacters() {
    const bgmId = this.anime.bgm_id;
    if (!bgmId) {
      this.characters = [];
      this.tabLoaded.characters = true;
      return Promise.resolve();
    }
    if (this._charactersPromise) return this._charactersPromise;
    this._charactersPromise = (async () => {
      try {
        const result = await window.electronAPI.bangumiGetCharacters(bgmId);
        this.characters = Array.isArray(result) ? result : [];
        this.tabLoaded.characters = true;
      } catch (e) {
        console.error('[AnimeDetail] 加载角色失败:', e);
        this.characters = [];
        // 失败时清空 promise，允许用户切到 Tab 时重试
        this._charactersPromise = null;
        this.tabLoaded.characters = false;
      }
    })();
    return this._charactersPromise;
  },

  /**
   * 加载制作人员数据（同 loadCharacters 的幂等策略）
   */
  loadStaff() {
    const bgmId = this.anime.bgm_id;
    if (!bgmId) {
      this.staff = [];
      this.tabLoaded.staff = true;
      return Promise.resolve();
    }
    if (this._staffPromise) return this._staffPromise;
    this._staffPromise = (async () => {
      try {
        const result = await window.electronAPI.bangumiGetStaff(bgmId);
        this.staff = Array.isArray(result) ? result : [];
        this.tabLoaded.staff = true;
      } catch (e) {
        console.error('[AnimeDetail] 加载制作人员失败:', e);
        this.staff = [];
        this._staffPromise = null;
        this.tabLoaded.staff = false;
      }
    })();
    return this._staffPromise;
  },

    async loadComments(page = 1) {
      const bgmId = this.anime.bgm_id;
      if (!bgmId) {
        console.warn('[AnimeDetail] 吐槽加载: 无 bgm_id，跳过');
        this.comments = [];
        return;
      }
      this.loadingTab = true;
      try {
        console.log('[AnimeDetail] 吐槽加载: 请求 bgm_id=%s page=%s', bgmId, page);
        const result = await window.electronAPI.bangumiGetComments(bgmId, page);
        console.log('[AnimeDetail] 吐槽加载: 响应=', result);
        this.comments = (result && Array.isArray(result.data)) ? result.data : [];
        this.commentsPagination = {
          page: (result && result.page) || page,
          totalPages: (result && result.totalPages) || 1,
          total: (result && result.total) || 0
        };
        if (result && result.error) {
          console.error('[AnimeDetail] 吐槽加载: 服务端返回错误=', result.error);
        }
      } catch (e) {
        console.error('[AnimeDetail] 吐槽加载: IPC 调用异常:', e);
        this.comments = [];
      } finally {
        this.loadingTab = false;
      }
    },

    /**
     * 角色 relation 映射为中文
     * Bangumi: 1=主角 2=配角 3=客串
     */
    relationLabel(relation) {
      const map = { 1: '主角', 2: '配角', 3: '客串' };
      return map[relation] || '';
    },

    /**
     * 头像加载失败时隐藏 img，让 placeholder 显示
     */
    onAvatarError(event) {
      event.target.style.display = 'none';
    },

    /**
     * 格式化日期 YYYY-MM-DD
     */
    formatDate(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  }
};
</script>

<style scoped>
/* ===== 弹窗入场动画：幕布式——内容上浮 + 轻缩放，仅合成层属性 ===== */
.modal-fade-enter-active {
  transition: opacity 0.32s var(--ease-smooth);
}
.modal-fade-enter-active .modal-content {
  transition: opacity 0.32s var(--ease-smooth), transform 0.32s var(--ease-smooth);
}
.modal-fade-leave-active {
  transition: opacity 0.24s var(--ease-smooth);
}
.modal-fade-leave-active .modal-content {
  transition: opacity 0.24s var(--ease-smooth), transform 0.24s var(--ease-smooth);
}
.modal-fade-enter-from {
  opacity: 0;
}
.modal-fade-enter-from .modal-content {
  opacity: 0;
  transform: translateY(18px) scale(0.96);
}
.modal-fade-leave-to {
  opacity: 0;
}
.modal-fade-leave-to .modal-content {
  opacity: 0;
  transform: translateY(10px) scale(0.97);
}

/* ===== 遮罩层：加深压暗 + 背景页面虚化，聚焦弹窗 ===== */
.anime-detail-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(14, 8, 13, 0.72);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

/* ===== 弹窗主体：影院深色基底 ===== */
.modal-content {
  position: relative;
  background: #17111d;
  border-radius: 16px;
  width: 100%;
  max-width: 1100px;
  max-height: 88vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(8, 3, 7, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.09);
  z-index: 1;
  contain: layout style paint;
}

/* ===== 弹窗内部拖拽 ===== */
.modal-content .modal-body {
  cursor: grab;
}

.modal-content .modal-body button,
.modal-content .modal-body a,
.modal-content .modal-body input,
.modal-content .modal-body select,
.modal-content .modal-body textarea {
  cursor: pointer;
}

.modal-content.modal-dragging,
.modal-content.modal-dragging * {
  cursor: grabbing !important;
  user-select: none !important;
  -webkit-user-select: none !important;
}

.modal-content.modal-drag-reset {
  transition: transform 0.3s var(--ease-smooth);
}

/* ===== 影院氛围底：封面放大模糊铺底 ===== */
.cinema-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

.cinema-backdrop-img {
  position: absolute;
  inset: -12%;
  background-color: #17111d;
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  /* 放大 + 模糊：掩盖低分辨率，只取封面的色彩氛围 */
  filter: blur(46px) saturate(1.55) brightness(0.68);
  transform: scale(1.12);
}

.cinema-backdrop-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(20, 12, 18, 0.22) 0%, rgba(18, 10, 16, 0.44) 55%, rgba(12, 7, 11, 0.66) 100%);
}

/* 纯净模式 / 软件渲染：去掉大面积模糊，仅保留暗化基底 */
[data-ui-effects="performance"] .cinema-backdrop-img,
[data-software-rendering="true"] .cinema-backdrop-img {
  filter: brightness(0.42) saturate(1.1);
  transform: none;
}

[data-ui-effects="performance"] .anime-detail-modal,
[data-software-rendering="true"] .anime-detail-modal {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* ===== 关闭按钮：深色玻璃，浮在影院边缘 ===== */
.close-btn {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 36px;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.2s var(--ease-smooth);
  z-index: 10;
}

.close-icon {
  font-size: 14px;
  color: #ffffff;
  transition: transform 0.25s;
}

.close-btn:hover {
  background: var(--primary-color);
  border-color: var(--primary-color);
  transform: rotate(90deg);
}

.close-btn:hover .close-icon {
  color: var(--text-inverse);
}

.episode-opening-notice {
  position: absolute;
  top: 12px;
  right: 62px;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 38px;
  max-width: min(360px, calc(100% - 126px));
  padding: 8px 13px;
  border: 1px solid rgba(var(--primary-rgb), 0.45);
  border-radius: 8px;
  background: rgba(22, 14, 20, 0.82);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #ffffff;
  box-shadow: 0 8px 22px rgba(5, 2, 4, 0.4);
  font-size: 13px;
  font-weight: 600;
}

.episode-opening-notice .loading-spinner {
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
}

.episode-opening-fade-enter-active,
.episode-opening-fade-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.episode-opening-fade-enter-from,
.episode-opening-fade-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}

/* ===== 内容区域：玻璃浮层卡片，四周露出影院氛围边缘 ===== */
.modal-body {
  margin: 10px;
  padding: 26px 26px 22px;
  overflow-y: auto;
  flex: 1;
  position: relative;
  z-index: 1;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

[data-theme="dark"] .modal-body {
  background: rgba(33, 27, 40, 0.84);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

/* 纯净模式 / 软件渲染：浮层不透玻璃化，直接实底 */
[data-ui-effects="performance"] .modal-body,
[data-software-rendering="true"] .modal-body {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: var(--bg-card);
}

.modal-body::-webkit-scrollbar {
  width: 6px;
}

.modal-body::-webkit-scrollbar-track {
  background: transparent;
}

.modal-body::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 3px;
}

.modal-body::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

/* ===== 封面 + 信息区 ===== */
.anime-info-section {
  display: flex;
  gap: 24px;
  margin-bottom: 28px;
  /* 顶部简介展开时，阻止封面 wrapper 被拉伸到与右侧等高 */
  align-items: flex-start;
}

.anime-cover-wrapper {
  flex-shrink: 0;
  position: relative;
}

.cover-glow {
  position: absolute;
  inset: -7px;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-cyan));
  opacity: 0.32;
  filter: blur(10px);
  border-radius: 18px;
  z-index: 0;
}

.anime-cover {
  position: relative;
  width: 160px;
  height: 220px;
  object-fit: cover;
  border-radius: 10px;
  border: 2px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 16px 36px rgba(5, 2, 6, 0.42);
  z-index: 1;
}

.anime-details {
  flex: 1;
  min-width: 0;
}

.detail-loading-state {
  min-height: min(560px, calc(85vh - 64px));
  box-sizing: border-box;
}

.detail-loading-state :deep(.sakurane-loading-art) {
  width: 96px;
  height: 135px;
  filter: drop-shadow(0 14px 22px rgba(var(--primary-rgb), 0.22));
}

.detail-loading-state :deep(.loading-text) {
  color: var(--text-secondary);
  font-size: 13px;
}

.title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
}

.anime-title {
  margin: 0;
  font-size: 23px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.4;
  letter-spacing: 0.5px;
  flex: 1;
}

/* ===== 收藏按钮 ===== */
.fav-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 14px;
  border: 1px solid var(--border-color);
  background: var(--bg-card-glass);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;
  flex-shrink: 0;
  white-space: nowrap;
}

.fav-btn:hover {
  border-color: var(--primary-color);
}

.fav-btn.favorited {
  border-color: var(--primary-color);
  background: var(--primary-light);
  color: var(--primary-color);
}

/* ===== 信息标签 ===== */
.info-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.info-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  min-height: 28px;
  padding: 4px 10px;
  background: var(--bg-card-glass);
  border: 1px solid var(--tag-border);
  border-radius: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--tag-text);
}

.tag-icon {
  font-size: 12px;
}

/* ===== 类型标签 ===== */
.type-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}

.type-tag {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-height: 28px;
  padding: 4px 12px;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  color: var(--text-inverse);
  border-radius: var(--radius-pill);
  box-shadow: 0 3px 10px rgba(var(--primary-rgb), 0.28);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  letter-spacing: 0;
}

/* ===== 简介 ===== */
.intro-section {
  margin-bottom: 4px;
}

.intro-text {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.8;
  max-height: 54px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.intro-text.expanded {
  max-height: 500px;
}

.expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 2px 10px;
  background: none;
  border: none;
  color: var(--primary-color);
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.expand-btn:hover {
  opacity: 0.8;
  background: none;
}

.expand-arrow {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.3s;
}

.expand-arrow.flipped {
  transform: rotate(180deg);
}

/* ===== 线路选择 ===== */
.line-selector {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.line-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 18px;
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  background: var(--bg-card-glass);
  color: var(--tag-text);
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.24s var(--ease-smooth), border-color 0.24s var(--ease-smooth), color 0.24s var(--ease-smooth), box-shadow 0.24s var(--ease-smooth);
  font-size: 13px;
  font-weight: 500;
}

.line-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
  transition: background 0.25s var(--ease-smooth), box-shadow 0.25s var(--ease-smooth);
}

.line-btn:hover {
  border-color: rgba(var(--primary-rgb), 0.4);
  background: rgba(var(--primary-rgb), 0.07);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.06);
}

.line-btn:hover .line-dot {
  background: var(--primary-color);
  box-shadow: 0 0 6px rgba(var(--primary-rgb), 0.55);
}

.line-btn.active {
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  color: var(--text-inverse);
  border-color: transparent;
}

.line-btn.active .line-dot {
  background: var(--text-inverse);
}

/* ===== 剧集列表 ===== */
.episodes-section {
  margin-bottom: 24px;
}

.section-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.label-icon {
  font-size: 16px;
}

.episodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  gap: 8px;
  contain: layout style;
}

.episode-btn {
  position: relative;
  padding: 10px 4px;
  min-height: 42px;
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  background: var(--bg-card-glass);
  color: var(--text-secondary);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.26s var(--ease-smooth), background-color 0.26s var(--ease-smooth), color 0.26s var(--ease-smooth), box-shadow 0.26s var(--ease-smooth);
  text-align: center;
  overflow: hidden;
  contain: layout style paint;
}

.ep-number {
  position: relative;
  z-index: 1;
  font-size: 13px;
  font-weight: 600;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.episode-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  opacity: 0;
  transition: opacity 0.25s;
  border-radius: 7px;
}

.episode-btn:hover:not(:disabled) {
  border-color: rgba(var(--primary-rgb), 0.38);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.08), 0 4px 14px -8px rgba(var(--primary-rgb), 0.35);
}

.episode-btn:hover:not(:disabled)::before {
  opacity: 0.13;
}

.episode-btn:active:not(:disabled) {
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.14);
}

.episode-btn.active {
  border-color: transparent;
}

.episode-btn.active::before {
  opacity: 1;
}

.episode-btn.active .ep-number {
  color: var(--text-inverse);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}

.episode-btn.loading {
  border-color: var(--border-color-strong);
  cursor: wait;
}

.episode-btn.loading .ep-number {
  color: var(--primary-color);
  opacity: 0.42;
}

.episode-btn.loading::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border: 2px solid rgba(var(--primary-rgb), 0.2);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: episode-button-spin 0.7s linear infinite;
}

@keyframes episode-button-spin {
  to { transform: rotate(360deg); }
}

/* ===== 无剧集提示 + 联动搜索 ===== */
.no-episodes-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
}

.no-episodes-hint::before {
  content: '';
  width: 96px;
  aspect-ratio: 1;
  background: var(--sakura-charm-image) center / contain no-repeat;
  filter: drop-shadow(0 14px 24px rgba(var(--primary-rgb), 0.18));
  opacity: 0.9;
}

.no-ep-text {
  font-size: 13px;
  color: var(--text-tertiary);
  margin: 0;
}

.source-search-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  color: var(--text-inverse);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: filter 0.2s ease;
}

.source-search-btn:hover {
  filter: brightness(1.04);
}

.source-search-btn:active {
  filter: brightness(0.98);
}

/* ===== 多源播放候选区（Bangumi 模式） ===== */
.play-sources-section {
  margin-top: 4px;
}

.sources-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px 12px;
  color: var(--text-tertiary);
  font-size: 13px;
}

.sources-loading::before,
.tab-loading::before {
  content: '';
  width: 42px;
  height: 56px;
  flex-shrink: 0;
  background: var(--sakura-mascot-image) center bottom / contain no-repeat;
  filter: drop-shadow(0 10px 16px rgba(var(--primary-rgb), 0.22));
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.play-source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-background-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.16);
  border-radius: 7px;
  background: var(--bg-card-glass);
  color: var(--text-tertiary);
  font-size: 12px;
}

.source-search-notice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-left: 3px solid var(--primary-color);
  border-radius: 6px;
  background: var(--primary-lighter);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.source-search-notice strong {
  color: var(--text-primary);
  font-size: 13px;
}

.play-source-card {
  position: relative;
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 10px;
  background: var(--bg-card-glass);
  overflow: hidden;
  transition: border-color 0.24s var(--ease-smooth), background-color 0.24s var(--ease-smooth), box-shadow 0.24s var(--ease-smooth);
}

/* 鼠标跟随光晕：圆心由 --glow-x/--glow-y 驱动（Linear 风格 cursor-tracking glow） */
.play-source-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(280px circle at var(--glow-x, 50%) var(--glow-y, 50%), rgba(var(--primary-rgb), 0.1), transparent 65%);
  opacity: 0;
  transition: opacity 0.35s var(--ease-smooth);
  pointer-events: none;
}

.play-source-card:hover {
  border-color: rgba(var(--primary-rgb), 0.32);
  box-shadow: 0 8px 24px -14px rgba(var(--primary-rgb), 0.3);
}

.play-source-card:hover::before {
  opacity: 1;
}

.play-source-card.expanded {
  border-color: rgba(var(--primary-rgb), 0.45);
}

/* 纯净模式守卫：关闭光晕跟随（与全局动效档位一致） */
[data-ui-effects="performance"] .play-source-card::before {
  display: none;
}

/* Phase 3: per-source 状态样式 */
.play-source-card.source-status-noResult,
.play-source-card.source-status-error,
.play-source-card.source-status-disabled,
.play-source-card.unreliable,
.play-source-card.empty {
  opacity: 0.72;
}

.source-status-dot {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.source-status-dot.dot-success { background: #4ade80; }
.source-status-dot.dot-noResult { background: #94a3b8; }
.source-status-dot.dot-error { background: #f87171; }
.source-status-dot.dot-disabled { background: #fbbf24; }
.source-status-dot.dot-pending { background: #60a5fa; animation: dot-pulse 1.2s infinite; }

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.source-header {
  position: relative; /* 浮于 ::before 光晕层之上 */
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.22s var(--ease-smooth);
}

.play-source-card.unreliable .source-header,
.play-source-card.source-status-noResult .source-header,
.play-source-card.source-status-error .source-header,
.play-source-card.source-status-disabled .source-header,
.play-source-card.empty .source-header {
  cursor: default;
}

.source-header:hover {
  background: rgba(var(--primary-rgb), 0.07);
}

.source-header:hover .source-name {
  color: var(--primary-color);
}

.source-header:hover .source-expand-icon {
  color: var(--primary-color);
}

.source-name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  transition: color 0.22s var(--ease-smooth);
}

.source-trust-chip {
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid rgba(96, 165, 250, 0.18);
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.1);
  color: #60a5fa;
  font-size: 11px;
  line-height: 1.4;
}

.source-trust-chip.recommended {
  border-color: rgba(var(--primary-rgb), 0.24);
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--primary-color);
}

.source-trust-chip.verified {
  border-color: rgba(74, 222, 128, 0.2);
  background: rgba(74, 222, 128, 0.1);
  color: #4ade80;
}

.source-meta {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 2px 8px;
  background: var(--tag-bg);
  border-radius: 10px;
}

.source-meta.muted { color: var(--text-tertiary); }
.source-meta.error { color: #f87171; background: rgba(248, 113, 113, 0.12); }

.source-line-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.source-line-label {
  margin-right: 2px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.source-line-btn {
  min-width: 58px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.2s var(--ease-smooth), background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth);
}

.source-line-btn:hover {
  border-color: rgba(var(--primary-rgb), 0.4);
  background: rgba(var(--primary-rgb), 0.08);
  color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.06);
}

.source-line-btn.active {
  border-color: rgba(var(--primary-rgb), 0.35);
  background: var(--primary-lighter);
  color: var(--primary-color);
}

.source-expand-icon {
  display: inline-block;
  font-size: 10px;
  color: var(--text-tertiary);
  transform: rotate(0deg);
  transition: transform 0.24s var(--ease-smooth), color 0.24s var(--ease-smooth);
}

.source-expand-icon.open {
  transform: rotate(90deg);
}

.source-episodes {
  position: relative; /* 浮于 ::before 光晕层之上 */
  padding: 8px 14px 12px;
  border-top: 1px solid var(--border-color);
  content-visibility: auto;
  contain-intrinsic-size: 180px;
}

/* ===== Bangumi 官方分集信息（只读） ===== */
.official-eps-section {
  margin-top: 20px;
}

.official-eps-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  padding-right: 4px;
}

.official-eps-list::-webkit-scrollbar {
  width: 4px;
}

.official-eps-list::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 2px;
}

.official-ep-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--bg-elevated);
  border-radius: 6px;
}

.official-ep-item .ep-num {
  color: var(--primary-color);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 50px;
}

.official-ep-item .ep-title {
  flex: 1;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.official-ep-item .ep-date {
  color: var(--text-tertiary);
  font-size: 11px;
  flex-shrink: 0;
}

/* ===== Bangumi Tab 导航 ===== */
.bgm-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 18px;
  padding: 0 2px;
}

.bgm-tab {
  padding: 10px 18px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  transition: color 0.2s;
  border-radius: 8px;
}

.bgm-tab:hover {
  color: var(--primary-color);
  background: var(--primary-lighter);
}

.bgm-tab:disabled {
  opacity: 0.5;
  cursor: default;
  background: transparent;
}

.bgm-tab.active {
  color: var(--primary-color);
  font-weight: 600;
  background: var(--nav-active-bg);
}

.bgm-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -2px;
  height: 2px;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-cyan));
  border-radius: 2px;
}

.bgm-tab-content {
  min-height: 120px;
}

/* ===== Tab 通用加载/空状态 ===== */
.tab-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 32px 12px;
  color: var(--text-tertiary);
  font-size: 13px;
  justify-content: center;
}

.tab-empty {
  padding: 32px 12px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* ===== 手帐回顾 Tab ===== */
.notes-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notes-empty strong { color: var(--text-secondary, rgba(255, 255, 255, 0.75)); }

.notes-review {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.notes-review-hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 11px;
  letter-spacing: 0.4px;
}

.notes-review-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border-light, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  background: var(--bg-card-glass, rgba(255, 255, 255, 0.03));
}

.notes-review-ep {
  color: var(--accent-pink, #f26d9f);
  font-size: 12px;
  font-weight: 700;
}

.notes-review-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  line-height: 1.55;
}

.notes-review-time {
  flex: 0 0 auto;
  color: var(--accent-cyan, #8edfff);
  font: 700 12px/1.4 monospace;
}

.notes-review-badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.notes-review-badge.is-line { background: rgba(142, 223, 255, 0.16); color: #8edfff; }
.notes-review-badge.is-foreshadow { background: rgba(199, 155, 255, 0.16); color: #c79bff; }
.notes-review-badge.is-art { background: rgba(255, 180, 106, 0.16); color: #ffb46a; }
.notes-review-badge.is-music { background: rgba(125, 232, 164, 0.16); color: #7de8a4; }

.notes-review-text {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary, rgba(255, 255, 255, 0.82));
}

/* ===== 概览 Tab ===== */
.bgm-overview {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.rating-block {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  padding: 16px;
  background: var(--bg-card-glass);
  border-radius: 8px;
  border: 1px solid rgba(var(--primary-rgb), 0.14);
}

.rating-summary {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 100px;
  flex-shrink: 0;
}

.rating-score {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 34px;
  font-weight: 800;
  color: var(--primary-color);
  line-height: 1;
  padding: 6px 16px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.14), rgba(129, 117, 215, 0.12));
  border: 1px solid rgba(var(--primary-rgb), 0.28);
  text-shadow: 0 0 20px rgba(var(--primary-rgb), 0.5);
  box-shadow: 0 4px 18px rgba(var(--primary-rgb), 0.18);
}

.rating-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.stars-row {
  display: flex;
  gap: 1px;
}

.star {
  font-size: 12px;
  color: var(--border-color-strong);
}

.star.filled {
  color: #ffb400;
}

.rating-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

.rating-rank {
  font-size: 12px;
  color: var(--primary-color);
  font-weight: 600;
}

.rating-histogram {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.hist-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.hist-label {
  width: 16px;
  text-align: right;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.hist-bar-track {
  flex: 1;
  height: 10px;
  background: var(--tag-bg);
  border-radius: 5px;
  overflow: hidden;
  min-width: 0;
}

.hist-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-cyan));
  border-radius: 5px;
  transition: width 0.3s ease;
}

.hist-count {
  width: 36px;
  text-align: right;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* ===== 收藏统计 ===== */
.collection-stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 14px;
  background: var(--bg-card-glass);
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 8px;
  min-width: 60px;
}

.stat-label {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 2px;
}

.stat-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

/* ===== Tags 云 ===== */
.tags-block {
  /* 区块容器 */
}

.block-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.tags-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  min-height: 28px;
  padding: 4px 12px;
  background: var(--bg-card-glass);
  border: 1px solid var(--tag-border);
  color: var(--tag-text);
  border-radius: var(--radius-pill);
  font-size: 12px;
  line-height: 18px;
  letter-spacing: 0;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, transform 0.2s var(--ease-smooth), box-shadow 0.2s ease;
}

.tag-chip:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.16);
}

.tag-count {
  font-size: 10px;
  line-height: 1;
  color: var(--text-tertiary);
}

/* ===== 角色网格 ===== */
.characters-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.char-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  transition: border-color 0.2s;
  content-visibility: auto;
  contain-intrinsic-size: 150px;
}

.char-card:hover {
  border-color: var(--primary-color);
}

.char-avatar-wrap {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  overflow: hidden;
  margin-bottom: 8px;
  background: var(--tag-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.char-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.char-avatar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 28px;
  color: var(--text-tertiary);
  font-weight: 600;
  background: var(--tag-bg);
}

.char-info {
  text-align: center;
  width: 100%;
}

.char-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 2px;
}

.char-relation {
  font-size: 11px;
  color: var(--primary-color);
  margin-bottom: 4px;
}

.char-actor {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actor-label {
  color: var(--text-tertiary);
  margin-right: 2px;
}

.actor-name {
  color: var(--text-secondary);
}

/* ===== 制作人员列表 ===== */
.staff-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.staff-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  transition: border-color 0.2s;
  content-visibility: auto;
  contain-intrinsic-size: 72px;
}

.staff-card:hover {
  border-color: var(--primary-color);
}

.staff-avatar-wrap {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--tag-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.staff-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.staff-avatar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 18px;
  color: var(--text-tertiary);
  font-weight: 600;
  background: var(--tag-bg);
}

.staff-info {
  flex: 1;
  min-width: 0;
}

.staff-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

.staff-positions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.position-tag {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--primary-lighter);
  color: var(--primary-color);
  border-radius: 8px;
}

/* ===== 短评列表 ===== */
.comments-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.comment-card {
  padding: 12px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  content-visibility: auto;
  contain-intrinsic-size: 112px;
}

.comment-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.comment-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--tag-bg);
}

.comment-avatar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--text-tertiary);
  font-weight: 600;
}

.comment-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.comment-user {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.comment-rate {
  font-size: 11px;
  color: #ffb400;
}

.comment-date {
  font-size: 11px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.comment-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
  word-break: break-word;
}

/* ===== 短评分页 ===== */
.comments-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.page-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: border-color 0.2s, color 0.2s;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-info {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .anime-info-section {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .anime-cover {
    width: 140px;
    height: 190px;
  }

  .title-row {
    flex-direction: column;
    align-items: center;
  }

  .info-tags,
  .type-tags {
    justify-content: center;
  }

  .anime-details {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .intro-text {
    text-align: left;
  }

  .episodes-grid {
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  }

  .modal-body {
    padding: 20px 16px;
  }

  /* Bangumi Tab 移动端适配 */
  .bgm-tabs {
    overflow-x: auto;
    flex-wrap: nowrap;
    -webkit-overflow-scrolling: touch;
  }

  .bgm-tab {
    flex-shrink: 0;
    padding: 10px 14px;
  }

  .rating-block {
    flex-direction: column;
    gap: 16px;
  }

  .characters-grid {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
  }

  .staff-list {
    grid-template-columns: 1fr;
  }
}
</style>
