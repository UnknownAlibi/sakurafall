const DEFAULT_SERVICE_BASE_URL = 'https://47.109.87.3:8443';

function normalizeServiceBaseUrl(value = DEFAULT_SERVICE_BASE_URL) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

const SERVICE_BASE_URL = process.env.SAKURAFALL_SERVICE_URL === 'off'
  ? ''
  : normalizeServiceBaseUrl(process.env.SAKURAFALL_SERVICE_URL || DEFAULT_SERVICE_BASE_URL);

module.exports = {
  DEFAULT_SERVICE_BASE_URL,
  SERVICE_BASE_URL,
  UPDATE_MANIFEST_URL: SERVICE_BASE_URL ? `${SERVICE_BASE_URL}/updates/latest.json` : ''
};
