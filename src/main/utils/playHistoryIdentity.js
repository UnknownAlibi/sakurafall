function toPositiveInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAnimeData(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeHistoryTitle(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, '')
        .trim()
        .toLocaleLowerCase();
}

function getPlayHistoryIdentity(row = {}) {
    const animeData = parseAnimeData(row.anime_data);
    const bgmId = toPositiveInteger(
        row.bgm_id ?? row.bgmId ?? animeData?.bgm_id ?? animeData?.bgmId
    );
    if (bgmId) return `bgm:${bgmId}`;

    const title = normalizeHistoryTitle(row.name || animeData?.name);
    if (title) return `title:${title}`;

    return `entry:${row.source || 'legacy'}:${String(row.anime_id ?? row.id ?? '')}`;
}

function normalizePlayHistoryRow(row = {}) {
    return {
        ...row,
        anime_data: parseAnimeData(row.anime_data)
    };
}

function dedupePlayHistoryRows(rows = [], limit = Number.POSITIVE_INFINITY) {
    const safeLimit = Number.isFinite(Number(limit))
        ? Math.max(0, Math.floor(Number(limit)))
        : Number.POSITIVE_INFINITY;
    const seen = new Set();
    const result = [];

    for (const rawRow of rows) {
        const row = normalizePlayHistoryRow(rawRow);
        const identity = getPlayHistoryIdentity(row);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(row);
        if (result.length >= safeLimit) break;
    }

    return result;
}

module.exports = {
    dedupePlayHistoryRows,
    getPlayHistoryIdentity,
    normalizeHistoryTitle,
    normalizePlayHistoryRow,
    parseAnimeData,
    toPositiveInteger
};
