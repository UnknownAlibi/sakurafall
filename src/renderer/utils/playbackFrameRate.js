const COMMON_SOURCE_FRAME_RATES = Object.freeze([
  23.976,
  24,
  25,
  29.97,
  30,
  47.952,
  48,
  50,
  59.94,
  60,
  90,
  100,
  119.88,
  120
]);

function toValidFrameRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 1 && rate <= 240 ? rate : 0;
}

function findNearestCommonFrameRate(value) {
  return COMMON_SOURCE_FRAME_RATES.reduce((nearest, candidate) => (
    Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest
  ), COMMON_SOURCE_FRAME_RATES[0]);
}

export function normalizeDeclaredFrameRate(value) {
  const rate = toValidFrameRate(value);
  if (!rate) return 0;
  const nearest = findNearestCommonFrameRate(rate);
  const tolerance = Math.max(0.06, nearest * 0.0015);
  return Math.abs(nearest - rate) <= tolerance
    ? nearest
    : Math.round(rate * 1000) / 1000;
}

export function estimateSourceFrameRate(samples, minimumSamples = 4) {
  const validSamples = (Array.isArray(samples) ? samples : [])
    .map(toValidFrameRate)
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (validSamples.length < minimumSamples) return 0;

  const middle = Math.floor(validSamples.length / 2);
  const median = validSamples.length % 2
    ? validSamples[middle]
    : (validSamples[middle - 1] + validSamples[middle]) / 2;
  const outlierTolerance = Math.max(1.25, median * 0.06);
  const stableSamples = validSamples.filter(sample => Math.abs(sample - median) <= outlierTolerance);
  if (stableSamples.length < minimumSamples) return 0;

  const average = stableSamples.reduce((sum, sample) => sum + sample, 0) / stableSamples.length;
  const nearest = findNearestCommonFrameRate(average);
  const snapTolerance = Math.max(0.9, nearest * 0.025);
  return Math.abs(nearest - average) <= snapTolerance
    ? nearest
    : Math.round(average * 10) / 10;
}

export function formatSourceFrameRate(value) {
  const rate = toValidFrameRate(value);
  if (!rate) return '';
  if (Number.isInteger(rate)) return String(rate);
  return String(Math.round(rate * 1000) / 1000);
}

export { COMMON_SOURCE_FRAME_RATES };
