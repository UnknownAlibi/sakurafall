export function toIpcPlainObject(value, fallback = {}) {
  if (value === null || value === undefined) return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch (_error) {
    return fallback;
  }
}
