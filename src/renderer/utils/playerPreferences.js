export const SEEK_STEP_OPTIONS = Object.freeze([5, 10, 15, 30]);

export function normalizeSeekStepSeconds(value, fallback = 10) {
  const seconds = Number(value);
  return SEEK_STEP_OPTIONS.includes(seconds) ? seconds : fallback;
}
