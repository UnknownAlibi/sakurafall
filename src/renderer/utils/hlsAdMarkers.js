const INTERSTITIAL_CLASS = 'com.apple.hls.interstitial';
const EXPLICIT_AD_CLASS = /(?:^|[._:/-])(?:ad|ads|advert|commercial|interstitial|preroll|midroll|postroll)(?:$|[._:/-])/i;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasScte35Attribute(attributes = {}) {
  return Object.keys(attributes).some(key => /^SCTE35-(?:OUT|IN|CMD)$/i.test(key));
}

function isExplicitAdDateRange(range = {}) {
  const attributes = range.attr || range.attributes || {};
  const className = String(range.class || attributes.CLASS || '');
  return range.isInterstitial === true
    || className.toLowerCase() === INTERSTITIAL_CLASS
    || EXPLICIT_AD_CLASS.test(className)
    || hasScte35Attribute(attributes);
}

function normalizeDateRange(range, fallbackId) {
  if (!isExplicitAdDateRange(range)) return null;
  const start = finiteNumber(range.startTime);
  const duration = finiteNumber(range.duration);
  if (start == null || duration == null || duration <= 0 || duration > 15 * 60) return null;
  return {
    id: String(range.id || range.attr?.ID || fallbackId),
    start: Math.max(0, start),
    end: Math.max(0, start + duration),
    marker: range.isInterstitial ? 'interstitial' : (hasScte35Attribute(range.attr) ? 'scte35' : 'daterange')
  };
}

function parseCueDuration(tags = []) {
  for (const tag of tags) {
    const name = String(tag?.[0] || '').toUpperCase();
    if (!/(?:CUE-OUT|SCTE35-OUT)/.test(name)) continue;
    const value = String(tag?.[1] || '');
    const direct = finiteNumber(value);
    if (direct != null && direct > 0) return direct;
    const match = value.match(/(?:DURATION=)?([0-9]+(?:\.[0-9]+)?)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function collectCueRanges(fragments = []) {
  const ranges = [];
  let openRange = null;
  for (const fragment of fragments) {
    const tags = Array.isArray(fragment?.tagList) ? fragment.tagList : [];
    const start = finiteNumber(fragment?.start);
    if (start == null) continue;
    const hasOut = tags.some(tag => /(?:CUE-OUT|SCTE35-OUT)/i.test(String(tag?.[0] || '')));
    const hasIn = tags.some(tag => /(?:CUE-IN|SCTE35-IN)/i.test(String(tag?.[0] || '')));
    if (hasIn && openRange) {
      openRange.end = start;
      if (openRange.end > openRange.start) ranges.push(openRange);
      openRange = null;
    }
    if (hasOut && !openRange) {
      const duration = parseCueDuration(tags);
      openRange = {
        id: `cue-${fragment.sn ?? ranges.length}-${start}`,
        start,
        end: duration && duration <= 15 * 60 ? start + duration : 0,
        marker: 'cue'
      };
      if (openRange.end > openRange.start) {
        ranges.push(openRange);
        openRange = null;
      }
    }
  }
  return ranges;
}

function fragmentDuration(fragment) {
  const duration = finiteNumber(fragment?.duration);
  if (duration != null && duration > 0) return duration;
  const start = finiteNumber(fragment?.start);
  const end = finiteNumber(fragment?.end);
  return start != null && end != null && end > start ? end - start : 0;
}

function fragmentContinuity(fragment, fallback) {
  const value = fragment?.cc ?? fragment?.continuityCounter ?? fragment?.discontinuitySequence;
  return value == null ? fallback : String(value);
}

/**
 * Some HLS providers insert ads as short discontinuity groups without SCTE-35
 * metadata. Treat only short groups around a clearly longer main-content group
 * as ads. Live playlists are excluded because their partial windows are too
 * easy to misclassify.
 */
export function collectDiscontinuityAdRanges(details = {}) {
  if (details?.live === true) return [];
  const fragments = Array.isArray(details?.fragments) ? details.fragments : [];
  if (fragments.length < 2) return [];

  const groups = [];
  let current = null;
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const continuity = fragmentContinuity(fragment, 0);
    if (!current || current.continuity !== continuity) {
      current = { continuity, fragments: [], duration: 0, start: null, end: null };
      groups.push(current);
    }
    const start = finiteNumber(fragment?.start);
    const duration = fragmentDuration(fragment);
    current.fragments.push(fragment);
    current.duration += duration;
    if (start != null) {
      current.start = current.start == null ? start : Math.min(current.start, start);
      current.end = Math.max(current.end ?? start, start + duration);
    }
  }

  if (groups.length <= 1) return [];
  const mainDuration = Math.max(...groups.map(group => group.duration));
  if (!Number.isFinite(mainDuration) || mainDuration < 60) return [];

  return groups.flatMap((group, index) => {
    if (group.duration === mainDuration || group.start == null || group.end == null) return [];
    const isEdgeGroup = index === 0 || index === groups.length - 1;
    const isLikelyAd = group.duration < 10
      || (isEdgeGroup && group.duration < 30)
      || (group.duration < mainDuration * 0.3 && group.duration < 120);
    if (!isLikelyAd) return [];
    return [{
      id: `discontinuity-${group.continuity}-${group.start}`,
      start: Math.max(0, group.start),
      end: Math.max(group.start, group.end),
      marker: 'discontinuity'
    }];
  });
}

export function collectExplicitHlsAdRanges(details = {}) {
  const ranges = [];
  const dateRanges = details?.dateRanges && typeof details.dateRanges === 'object'
    ? Object.values(details.dateRanges)
    : [];
  dateRanges.forEach((range, index) => {
    const normalized = normalizeDateRange(range, `daterange-${index}`);
    if (normalized) ranges.push(normalized);
  });
  ranges.push(...collectCueRanges(details?.fragments || []));

  return ranges
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start)
    .filter((range, index, items) => items.findIndex(item => (
      Math.abs(item.start - range.start) < 0.1 && Math.abs(item.end - range.end) < 0.1
    )) === index);
}

export function collectHlsAdRanges(details = {}) {
  // A discontinuity is also used for normal encoding changes, timeline resets,
  // intros and stitched content. It is useful as a diagnostic signal, but is
  // not strong enough to seek the video automatically. Only explicit HLS ad
  // metadata is allowed to produce an auto-skippable range.
  return collectExplicitHlsAdRanges(details);
}

export function findActiveAdRange(ranges, currentTime, skippedIds = []) {
  const time = finiteNumber(currentTime);
  if (time == null) return null;
  const skipped = new Set(skippedIds || []);
  return (ranges || []).find(range => (
    !skipped.has(range.id)
    && time >= range.start - 0.15
    && time < range.end - 0.05
  )) || null;
}

export { isExplicitAdDateRange };
