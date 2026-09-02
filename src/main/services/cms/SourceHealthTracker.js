/**
 * 源健康度跟踪器
 *
 * 从 CmsApiService.js 抽离的源健康度管理逻辑。
 * 负责跟踪各数据源的成功/失败计数、延迟、画质、冷却状态，
 * 并持久化到 JSON 文件。
 */
const fs = require('fs');
const path = require('path');

function safeError(...args) {
    if (typeof console !== 'undefined' && console.error) {
        try { console.error(...args); } catch (e) {}
    }
}

class SourceHealthTracker {
    constructor() {
        this.sourceHealth = new Map();
        this.healthStorePath = null;
        this.healthSaveTimer = null;
        this.SOURCE_HEALTH_STORE_VERSION = 3;
        this.SOURCE_COOLDOWN_TTL = 10 * 60 * 1000;
        this.UNSUPPORTED_SEARCH_TTL = 24 * 60 * 60 * 1000;
    }

    setHealthStorePath(filePath) {
        if (this.healthSaveTimer) {
            clearTimeout(this.healthSaveTimer);
            this.healthSaveTimer = null;
        }
        this.healthStorePath = filePath || null;
        this._loadSourceHealth();
    }

    _normalizeHealthRecord(record = {}) {
        const number = (value) => {
            const n = Number(value);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };
        const count = (value) => Math.floor(number(value));

        return {
            successCount: count(record.successCount),
            failureCount: count(record.failureCount),
            playbackSuccessCount: count(record.playbackSuccessCount),
            playbackFailureCount: count(record.playbackFailureCount),
            averageLatency: number(record.averageLatency),
            averageQualityHeight: number(record.averageQualityHeight),
            qualitySampleCount: count(record.qualitySampleCount),
            advertisingReportCount: count(record.advertisingReportCount),
            playbackSessionCount: count(record.playbackSessionCount),
            sustainedPlaybackCount: count(record.sustainedPlaybackCount),
            averageStartupMs: number(record.averageStartupMs),
            averagePlayedMs: number(record.averagePlayedMs),
            averageStallRatio: Math.max(0, Math.min(1, Number(record.averageStallRatio) || 0)),
            averageDroppedFrameRatio: Math.max(0, Math.min(1, Number(record.averageDroppedFrameRatio) || 0)),
            averageBitrate: number(record.averageBitrate),
            bitrateSampleCount: count(record.bitrateSampleCount),
            totalStallCount: count(record.totalStallCount),
            unexpectedPauseCount: count(record.unexpectedPauseCount),
            lastPlaybackAt: number(record.lastPlaybackAt),
            lastSustainedAt: number(record.lastSustainedAt),
            lastSuccessAt: number(record.lastSuccessAt),
            lastFailureAt: number(record.lastFailureAt),
            lastPlaybackFailureAt: number(record.lastPlaybackFailureAt),
            lastContentIssueAt: number(record.lastContentIssueAt),
            cooldownUntil: number(record.cooldownUntil),
            // 分类惩罚窗口（与 cooldown 独立）：广告反馈 / 持续卡顿
            adPenaltyUntil: number(record.adPenaltyUntil),
            stallPenaltyUntil: number(record.stallPenaltyUntil),
            reason: typeof record.reason === 'string' ? record.reason.slice(0, 240) : '',
            contentIssueReason: typeof record.contentIssueReason === 'string'
                ? record.contentIssueReason.slice(0, 80)
                : ''
        };
    }

    _loadSourceHealth() {
        if (!this.healthStorePath || !fs.existsSync(this.healthStorePath)) return false;
        try {
            const data = JSON.parse(fs.readFileSync(this.healthStorePath, 'utf8'));
            const sourceRecords = data?.sources && typeof data.sources === 'object'
                ? data.sources
                : data;
            const entries = Array.isArray(sourceRecords)
                ? sourceRecords.map(item => Array.isArray(item)
                    ? item
                    : [item?.sourceId || item?.id, item])
                : Object.entries(sourceRecords || {});

            for (const [sourceId, record] of entries) {
                if (!sourceId || !record || typeof record !== 'object') continue;
                this.sourceHealth.set(String(sourceId), this._normalizeHealthRecord(record));
            }
            return true;
        } catch (e) {
            safeError('[CmsApi] 读取源健康状态失败:', e.message);
            return false;
        }
    }

    _saveSourceHealth() {
        if (!this.healthStorePath) return false;
        try {
            const sources = {};
            for (const [sourceId, record] of this.sourceHealth.entries()) {
                if (!sourceId) continue;
                sources[String(sourceId)] = this._normalizeHealthRecord(record);
            }
            fs.mkdirSync(path.dirname(this.healthStorePath), { recursive: true });
            fs.writeFileSync(this.healthStorePath, JSON.stringify({
                version: this.SOURCE_HEALTH_STORE_VERSION,
                updatedAt: Date.now(),
                sources
            }, null, 2), 'utf8');
            return true;
        } catch (e) {
            safeError('[CmsApi] 保存源健康状态失败:', e.message);
            return false;
        }
    }

    _scheduleSourceHealthSave() {
        if (!this.healthStorePath) return;
        if (this.healthSaveTimer) clearTimeout(this.healthSaveTimer);
        this.healthSaveTimer = setTimeout(() => {
            this.healthSaveTimer = null;
            this._saveSourceHealth();
        }, 300);
        if (typeof this.healthSaveTimer.unref === 'function') {
            this.healthSaveTimer.unref();
        }
    }

    flushSourceHealth() {
        if (this.healthSaveTimer) {
            clearTimeout(this.healthSaveTimer);
            this.healthSaveTimer = null;
        }
        return this._saveSourceHealth();
    }

    clearSourceHealth({ persist = true } = {}) {
        this.sourceHealth.clear();
        if (this.healthSaveTimer) {
            clearTimeout(this.healthSaveTimer);
            this.healthSaveTimer = null;
        }
        if (persist) return this._saveSourceHealth();
        return true;
    }

    getHealth(sourceId) {
        const health = this.sourceHealth.get(sourceId) || {};
        const now = Date.now();
        const score = this.calculateSourceHealthScore(sourceId);
        return {
            score,
            successCount: health.successCount || 0,
            failureCount: health.failureCount || 0,
            playbackSuccessCount: health.playbackSuccessCount || 0,
            playbackFailureCount: health.playbackFailureCount || 0,
            averageLatency: Math.round(health.averageLatency || 0),
            averageQualityHeight: Math.round(health.averageQualityHeight || 0),
            advertisingReportCount: health.advertisingReportCount || 0,
            playbackSessionCount: health.playbackSessionCount || 0,
            sustainedPlaybackCount: health.sustainedPlaybackCount || 0,
            averageStartupMs: Math.round(health.averageStartupMs || 0),
            averagePlayedMs: Math.round(health.averagePlayedMs || 0),
            averageStallRatio: Number((health.averageStallRatio || 0).toFixed(4)),
            averageDroppedFrameRatio: Number((health.averageDroppedFrameRatio || 0).toFixed(4)),
            averageBitrate: Math.round(health.averageBitrate || 0),
            totalStallCount: health.totalStallCount || 0,
            unexpectedPauseCount: health.unexpectedPauseCount || 0,
            lastPlaybackAt: health.lastPlaybackAt || 0,
            lastSustainedAt: health.lastSustainedAt || 0,
            lastSuccessAt: health.lastSuccessAt || 0,
            lastFailureAt: health.lastFailureAt || 0,
            lastPlaybackFailureAt: health.lastPlaybackFailureAt || 0,
            lastContentIssueAt: health.lastContentIssueAt || 0,
            cooldownUntil: health.cooldownUntil || 0,
            adPenaltyUntil: health.adPenaltyUntil || 0,
            stallPenaltyUntil: health.stallPenaltyUntil || 0,
            reason: health.reason || '',
            contentIssueReason: health.contentIssueReason || '',
            coolingDown: !!(health.cooldownUntil && health.cooldownUntil > now)
        };
    }

    // 兼容旧方法名
    _getSourceHealth(sourceId) { return this.getHealth(sourceId); }

    _resetSourceHealth(sourceId) {
        const prev = this.sourceHealth.get(sourceId);
        if (!prev) return;
        this.sourceHealth.set(sourceId, {
            ...prev,
            failureCount: 0,
            cooldownUntil: 0,
            reason: ''
        });
        this._scheduleSourceHealthSave();
    }

    _average(prevValue, nextValue, prevCount = 0) {
        const value = Number(nextValue);
        if (!Number.isFinite(value) || value <= 0) return prevValue || 0;
        const count = Math.max(0, Number(prevCount) || 0);
        if (count <= 0 || !prevValue) return value;
        return (prevValue * count + value) / (count + 1);
    }

    _averageMetric(prevValue, nextValue, prevCount = 0) {
        const value = Number(nextValue);
        if (!Number.isFinite(value) || value < 0) return Number(prevValue) || 0;
        const count = Math.max(0, Number(prevCount) || 0);
        if (count <= 0) return value;
        return ((Number(prevValue) || 0) * count + value) / (count + 1);
    }

    recordPlaybackSession(sourceId, metrics = {}) {
        if (!sourceId) return false;
        const prev = this.sourceHealth.get(sourceId) || {};
        const sampleCount = prev.playbackSessionCount || 0;
        const playedMs = Math.max(0, Number(metrics.playedMs) || 0);
        const stallMs = Math.max(0, Number(metrics.stallMs) || 0);
        const totalFrames = Math.max(0, Number(metrics.totalFrames) || 0);
        const droppedFrames = Math.max(0, Number(metrics.droppedFrames) || 0);
        const stallRatio = playedMs + stallMs > 0 ? stallMs / (playedMs + stallMs) : 0;
        const droppedFrameRatio = totalFrames > 0 ? droppedFrames / totalFrames : 0;
        const now = Date.now();
        const sustained = metrics.sustained === true || playedMs >= 15000;

        this.sourceHealth.set(sourceId, {
            ...prev,
            playbackSessionCount: sampleCount + 1,
            sustainedPlaybackCount: (prev.sustainedPlaybackCount || 0) + (sustained ? 1 : 0),
            averageStartupMs: this._averageMetric(prev.averageStartupMs, metrics.startupMs, sampleCount),
            averagePlayedMs: this._averageMetric(prev.averagePlayedMs, playedMs, sampleCount),
            averageStallRatio: this._averageMetric(prev.averageStallRatio, stallRatio, sampleCount),
            averageDroppedFrameRatio: this._averageMetric(prev.averageDroppedFrameRatio, droppedFrameRatio, sampleCount),
            // 持续卡顿软惩罚窗口：播放 30s+ 且卡顿率 ≥6%，3 分钟内降权
            stallPenaltyUntil: (playedMs >= 30000 && stallRatio >= 0.06)
                ? now + 3 * 60 * 1000
                : (prev.stallPenaltyUntil || 0),
            averageBitrate: Number(metrics.bitrate) > 0
                ? this._averageMetric(prev.averageBitrate, metrics.bitrate, prev.bitrateSampleCount || 0)
                : (prev.averageBitrate || 0),
            bitrateSampleCount: Number(metrics.bitrate) > 0
                ? (prev.bitrateSampleCount || 0) + 1
                : (prev.bitrateSampleCount || 0),
            averageQualityHeight: Number(metrics.height) > 0
                ? this._averageMetric(prev.averageQualityHeight, metrics.height, prev.qualitySampleCount || 0)
                : (prev.averageQualityHeight || 0),
            qualitySampleCount: Number(metrics.height) > 0
                ? (prev.qualitySampleCount || 0) + 1
                : (prev.qualitySampleCount || 0),
            totalStallCount: (prev.totalStallCount || 0) + Math.max(0, Math.floor(Number(metrics.stallCount) || 0)),
            unexpectedPauseCount: (prev.unexpectedPauseCount || 0) + Math.max(0, Math.floor(Number(metrics.unexpectedPauseCount) || 0)),
            lastPlaybackAt: now,
            lastSustainedAt: sustained ? now : (prev.lastSustainedAt || 0)
        });
        this._scheduleSourceHealthSave();
        return true;
    }

    markSuccess(sourceId, meta = {}) {
        if (!sourceId) return;
        const now = Date.now();
        const prev = this.sourceHealth.get(sourceId) || {};
        const successCount = (prev.successCount || 0) + 1;
        const playbackSuccessCount = meta.playback
            ? (prev.playbackSuccessCount || 0) + 1
            : (prev.playbackSuccessCount || 0);
        const preservePlaybackCooldown = !meta.playback
            && (prev.cooldownUntil || 0) > now
            && (prev.playbackFailureCount || 0) > 0;

        this.sourceHealth.set(sourceId, {
            ...prev,
            successCount,
            playbackSuccessCount,
            playbackFailureCount: meta.playback ? 0 : (prev.playbackFailureCount || 0),
            failureCount: 0,
            cooldownUntil: preservePlaybackCooldown ? prev.cooldownUntil : 0,
            reason: preservePlaybackCooldown ? prev.reason : '',
            lastSuccessAt: now,
            averageLatency: this._average(prev.averageLatency, meta.latencyMs, successCount - 1),
            averageQualityHeight: this._average(
                prev.averageQualityHeight,
                meta.quality?.height || meta.qualityHeight,
                prev.qualitySampleCount || 0
            ),
            qualitySampleCount: (meta.quality?.height || meta.qualityHeight)
                ? (prev.qualitySampleCount || 0) + 1
                : (prev.qualitySampleCount || 0)
        });
        this._scheduleSourceHealthSave();
    }

    // 兼容旧方法名
    _markSourceSuccess(sourceId, meta) { return this.markSuccess(sourceId, meta); }

    /**
     * 播放失败惩罚窗口：按故障类型区分冷却时长。
     * DNS 解析失败 > 源站拒绝(403) > 连接超时 > 空清单 > 解码失败 > 未知
     */
    _playbackFailureRule(message) {
        const text = String(message || '');
        if (/ENOTFOUND|EAI_AGAIN|dns/i.test(text)) {
            return { ttl: 8 * 60 * 1000, reason: 'DNS 解析失败' };
        }
        if (/403|forbidden|拒绝访问/i.test(text)) {
            return { ttl: 12 * 60 * 1000, reason: '源站拒绝访问 (403)' };
        }
        if (/空清单|清单为空|empty[-\s]?manifest|no\s*playlist|manifestParsing/i.test(text)) {
            return { ttl: 4 * 60 * 1000, reason: '空清单/清单异常' };
        }
        if (/timeout|etimedout|econnreset|超时/i.test(text)) {
            return { ttl: 5 * 60 * 1000, reason: '连接超时' };
        }
        if (/decode|解码/i.test(text)) {
            return { ttl: 3 * 60 * 1000, reason: '解码失败' };
        }
        return { ttl: 6 * 60 * 1000, reason: '播放失败' };
    }

    markPlaybackFailure(sourceId, error) {
        if (!sourceId) return;
        const now = Date.now();
        const prev = this.sourceHealth.get(sourceId) || {};
        const playbackFailureCount = (prev.playbackFailureCount || 0) + 1;
        const rule = this._playbackFailureRule(error?.message || error);
        // 首次失败不冷却（可能是瞬时抖动），从第二次起按故障类型窗口指数升级
        const cooldownUntil = playbackFailureCount >= 2
            ? Math.max(prev.cooldownUntil || 0, now + rule.ttl * Math.min(3, playbackFailureCount - 1))
            : (prev.cooldownUntil || 0);

        this.sourceHealth.set(sourceId, {
            ...prev,
            playbackFailureCount,
            lastPlaybackFailureAt: now,
            lastFailureAt: now,
            cooldownUntil,
            reason: rule.reason
        });
        this._scheduleSourceHealthSave();
    }

    // 兼容旧方法名
    _markSourcePlaybackFailure(sourceId, error) { return this.markPlaybackFailure(sourceId, error); }

    reportContentIssue(sourceId, issue) {
        if (!sourceId || issue !== 'advertising') return false;
        const prev = this.sourceHealth.get(sourceId) || {};
        const count = (prev.advertisingReportCount || 0) + 1;
        // 广告反馈惩罚窗口：10 分钟起步，最多 30 分钟（软惩罚，只降排序不断源）
        const adPenaltyUntil = Date.now() + 10 * 60 * 1000 * Math.min(3, count);
        this.sourceHealth.set(sourceId, {
            ...prev,
            advertisingReportCount: count,
            lastContentIssueAt: Date.now(),
            contentIssueReason: issue,
            adPenaltyUntil
        });
        this._scheduleSourceHealthSave();
        return true;
    }

    calculateSourceHealthScore(sourceId) {
        const health = this.sourceHealth.get(sourceId) || {};
        const now = Date.now();
        let score = 60;

        // 历史次数采用对数增益，避免“成功过很多次”永久把分数锁死在 100。
        score += Math.min(10, Math.log2(1 + (health.successCount || 0)) * 2.5);
        score += Math.min(12, Math.log2(1 + (health.playbackSuccessCount || 0)) * 3.5);
        score -= Math.min(24, (health.failureCount || 0) * 8);
        score -= Math.min(36, (health.playbackFailureCount || 0) * 12);

        if (health.averageLatency > 0) {
            score += health.averageLatency <= 800
                ? 4
                : -Math.min(12, (health.averageLatency - 800) / 500);
        }
        if (health.averageQualityHeight >= 1080) score += 8;
        else if (health.averageQualityHeight >= 720) score += 4;
        else if (health.averageQualityHeight > 0 && health.averageQualityHeight < 480) score -= 6;
        // 一次明确的广告反馈应足以抵消一档清晰度优势，避免广告源仅靠 1080P 反复胜出。
        score -= Math.min(32, (health.advertisingReportCount || 0) * 8);

        const sessionCount = health.playbackSessionCount || 0;
        if (sessionCount > 0) {
            const confidence = Math.min(1, 0.35 + sessionCount / 5);
            if (health.averageStartupMs > 0) {
                score += (health.averageStartupMs <= 1200
                    ? 4
                    : -Math.min(16, (health.averageStartupMs - 1200) / 300)) * confidence;
            }
            score -= Math.min(30, (health.averageStallRatio || 0) * 140) * confidence;
            score -= Math.min(18, (health.averageDroppedFrameRatio || 0) * 300) * confidence;
            score -= Math.min(12, ((health.unexpectedPauseCount || 0) / sessionCount) * 8) * confidence;
            score += Math.min(8, ((health.sustainedPlaybackCount || 0) / sessionCount) * 8) * confidence;
        }
        if (health.cooldownUntil && health.cooldownUntil > now) score -= 45;
        // 分类软惩罚窗口：窗口期内额外降分
        if (health.adPenaltyUntil && health.adPenaltyUntil > now) score -= 10;
        if (health.stallPenaltyUntil && health.stallPenaltyUntil > now) score -= 12;
        return Math.max(0, Math.min(100, Math.round(score)));
    }

    recordPlaybackResult(sourceId, result = {}) {
        if (!sourceId) return { success: false, error: 'sourceId is required' };
        if (result.sample === 'session') {
            this.recordPlaybackSession(sourceId, result.metrics || {});
            return { success: true, health: this.getHealth(sourceId) };
        }
        if (result.issue) {
            const recorded = this.reportContentIssue(sourceId, result.issue);
            return recorded
                ? { success: true, health: this.getHealth(sourceId) }
                : { success: false, error: 'unsupported content issue' };
        }
        if (result.success) {
            this.markSuccess(sourceId, {
                playback: true,
                quality: result.quality,
                qualityHeight: result.qualityHeight
            });
        } else {
            this.markPlaybackFailure(sourceId, result.error || result.reason || 'playback failed');
        }
        return { success: true, health: this.getHealth(sourceId) };
    }

    _sourceCooldownReason(message) {
        const text = String(message || '');
        if (text.includes('暂不支持搜索')) {
            return { ttl: this.UNSUPPORTED_SEARCH_TTL, reason: '暂不支持搜索' };
        }
        if (/403|Forbidden/i.test(text)) {
            return { ttl: 30 * 60 * 1000, reason: '源站拒绝访问' };
        }
        if (/404|Not Found/i.test(text)) {
            return { ttl: 30 * 60 * 1000, reason: '接口不存在' };
        }
        if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(text)) {
            return { ttl: 5 * 60 * 1000, reason: '网络连接失败' };
        }
        return { ttl: this.SOURCE_COOLDOWN_TTL, reason: '搜索失败' };
    }

    markFailure(sourceId, error) {
        const now = Date.now();
        const prev = this.sourceHealth.get(sourceId) || {};
        const rule = this._sourceCooldownReason(error && error.message ? error.message : error);
        const failureCount = (prev.failureCount || 0) + 1;
        const ttl = rule.ttl * Math.min(3, failureCount);
        this.sourceHealth.set(sourceId, {
            ...prev,
            failureCount,
            lastFailureAt: now,
            cooldownUntil: now + ttl,
            reason: rule.reason
        });
        this._scheduleSourceHealthSave();
    }

    // 兼容旧方法名
    _markSourceFailure(sourceId, error) { return this.markFailure(sourceId, error); }

    isCoolingDown(sourceId) {
        return this.getHealth(sourceId).coolingDown;
    }

    // 兼容旧方法名
    _isSourceCoolingDown(sourceId) { return this.isCoolingDown(sourceId); }
}

module.exports = SourceHealthTracker;
