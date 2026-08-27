let dlnaService;
let enhancedPlayerService;
let subtitleService;

module.exports = {
  dlna: () => (dlnaService ||= require('./DlnaService')),
  enhanced: () => (enhancedPlayerService ||= require('./EnhancedPlayerService')),
  subtitle: () => (subtitleService ||= require('./SubtitleService')),
  shutdown: () => dlnaService?.shutdown()
};
