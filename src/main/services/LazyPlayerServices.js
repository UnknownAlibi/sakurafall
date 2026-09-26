let dlnaService;
let enhancedPlayerService;
let subtitleService;
// 代理配置可能早于服务实例化（启动时 applyNetworkConfig 即下发），先记住，首次加载时补上
let activeProxy = '';

function withProxy(service) {
  if (activeProxy && typeof service?.setProxy === 'function') service.setProxy(activeProxy);
  return service;
}

module.exports = {
  dlna: () => (dlnaService ||= require('./DlnaService')),
  enhanced: () => (enhancedPlayerService ||= require('./EnhancedPlayerService')),
  subtitle: () => (subtitleService ||= withProxy(require('./SubtitleService'))),
  applyProxy: (proxy) => {
    activeProxy = String(proxy || '').trim();
    if (subtitleService) subtitleService.setProxy(activeProxy);
  },
  shutdown: () => dlnaService?.shutdown()
};