const fs = require('fs');

// 手帐导出 Markdown 中嵌入的机器可读块标记
const NOTES_EXPORT_MARKER = 'sakurafall-viewing-notes';

const NOTE_CATEGORY_LABELS = {
  line: '台词',
  foreshadow: '伏笔',
  art: '作画',
  music: '音乐'
};

function formatNoteTimestamp(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function buildViewingNotesMarkdown(notes) {
  const groups = new Map();
  for (const note of notes) {
    const workName = note.anime_name || '未知作品';
    const list = groups.get(workName) || [];
    list.push(note);
    groups.set(workName, list);
  }

  const lines = ['# SakuraFall 樱月手帐导出', '', `导出时间: ${new Date().toLocaleString('zh-CN')}`, `时光签总数: ${notes.length}`, ''];
  for (const [workName, list] of groups) {
    lines.push(`## ${workName}`, '');
    const byEpisode = new Map();
    for (const note of list) {
      const ep = Number(note.episode_number);
      const key = Number.isFinite(ep) && ep > 0 ? `第${ep}集` : (note.episode_title || '未分集');
      const epList = byEpisode.get(key) || [];
      epList.push(note);
      byEpisode.set(key, epList);
    }
    for (const [epLabel, epNotes] of byEpisode) {
      const title = epNotes[0]?.episode_title ? ` · ${epNotes[0].episode_title}` : '';
      lines.push(`### ${epLabel}${title}`, '');
      for (const note of epNotes) {
        const category = NOTE_CATEGORY_LABELS[note.category] || '感想';
        const date = new Date(Number(note.created_at) || Date.now())
          .toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        lines.push(`- **[${formatNoteTimestamp(note.position)}] ${category}**: ${note.note || '收藏了这一刻'} _${date}_`);
      }
      lines.push('');
    }
  }
  lines.push(`<!-- ${NOTES_EXPORT_MARKER}`, JSON.stringify({ version: 1, notes }), `-->`, '');
  return lines.join('\n');
}

function parseViewingNotesMarkdown(content) {
  const text = String(content || '');
  const markerRegex = new RegExp(`<!--\\s*${NOTES_EXPORT_MARKER}\\s*([\\s\\S]*?)-->`);
  const match = text.match(markerRegex);
  if (!match) return { error: '文件中没有手帐数据块（非 SakuraFall 导出文件）' };
  try {
    const payload = JSON.parse(match[1]);
    const notes = Array.isArray(payload?.notes) ? payload.notes : null;
    if (!notes) return { error: '手帐数据块格式不正确' };
    return { notes };
  } catch (e) {
    return { error: '手帐数据块解析失败: ' + e.message };
  }
}

function registerLibraryIpc({ handle, animeDb, dialog, BrowserWindow }) {
  const attempt = (label, fallback, task) => async (...args) => {
    try {
      return await task(...args);
    } catch (error) {
      console.error(`[Library] ${label}:`, error);
      return typeof fallback === 'function' ? fallback(error, args) : fallback;
    }
  };

  const pickWindow = () => BrowserWindow?.getFocusedWindow?.() || BrowserWindow?.getAllWindows?.()[0] || null;

  handle('favorite-add', attempt('添加收藏失败', error => ({ error: error.message }),
    (_event, anime) => animeDb.addFavorite(anime)));
  handle('favorite-remove', attempt('取消收藏失败', error => ({ error: error.message }),
    (_event, animeId, source) => animeDb.removeFavorite(animeId, source)));
  handle('favorite-list', attempt('获取收藏列表失败', (error, args) => ({
    data: [], total: 0, page: args[1] || 1, limit: args[2] || 50, totalPages: 0, error: error.message
  }), (_event, page = 1, limit = 50) => animeDb.getFavoriteList(page, limit)));
  handle('favorite-check', attempt('检查收藏状态失败', false,
    (_event, animeId, source) => animeDb.isFavorite(animeId, source)));
  handle('favorite-check-batch', attempt('批量检查收藏状态失败', {},
    (_event, items) => animeDb.checkFavorites(items)));

  handle('history-update', attempt('更新播放历史失败', error => ({ error: error.message }),
    (_event, data) => animeDb.updateFavoriteAndHistory(data)));
  handle('history-recent', attempt('获取播放历史失败', [],
    (_event, limit = 10) => animeDb.getRecentPlayHistory(limit)));
  handle('history-progress', attempt('获取播放进度失败', null,
    (_event, animeId, source) => animeDb.getPlayProgress(animeId, source)));
  handle('history-remove', attempt('删除播放历史失败', error => ({ error: error.message }),
    (_event, animeId, source) => animeDb.removePlayHistory(animeId, source)));
  handle('history-clear', attempt('清空播放历史失败', error => ({ error: error.message }),
    () => animeDb.clearPlayHistory()));

  handle('viewing-note-add', attempt('保存手帐失败', error => ({ error: error.message }),
    (_event, data) => animeDb.addViewingNote(data)));
  handle('viewing-note-list', attempt('读取手帐失败', [],
    (_event, episodeKey, limit = 100) => animeDb.getViewingNotes(episodeKey, limit)));
  handle('viewing-note-remove', attempt('删除手帐失败', error => ({ error: error.message }),
    (_event, id) => animeDb.removeViewingNote(id)));

  // ===== Episode DNA P1：片头/片尾/广告段保存与确认 =====
  handle('episode-segment-save', attempt('保存剧集时间段失败', error => ({ error: error.message }),
    (_event, data) => animeDb.saveEpisodeSegment(data)));
  handle('episode-segment-list', attempt('读取剧集时间段失败', [],
    (_event, episodeKey) => animeDb.getEpisodeSegments(episodeKey)));
  handle('episode-segment-remove', attempt('删除剧集时间段失败', error => ({ error: error.message }),
    (_event, id) => animeDb.removeEpisodeSegment(id)));
  handle('episode-segment-auto-skip-rule', attempt('读取自动跳过规则失败', null,
    (_event, bgmId, workKey) => animeDb.getWorkAutoSkipRule(bgmId, workKey)));
  handle('viewing-note-list-work', attempt('读取作品手帐失败', [],
    (_event, bgmId, workKey) => animeDb.getViewingNotesForWork(bgmId, workKey)));
  handle('viewing-note-list-spoiler-safe', attempt('读取无剧透手帐失败', [],
    (_event, bgmId, workKey) => animeDb.getSpoilerSafeViewingNotes(bgmId, workKey)));

  handle('viewing-note-export', attempt('导出手帐失败', error => ({ error: error.message }),
    async () => {
      const notes = animeDb.getAllViewingNotes();
      if (notes.length === 0) return { error: '手帐还是空的，没有可导出的记录' };
      const win = pickWindow();
      const defaultName = `sakurafall-notes-${new Date().toISOString().slice(0, 10)}.md`;
      const options = {
        title: '导出樱月手帐',
        defaultPath: defaultName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      };
      const picked = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { canceled: true };
      const markdown = buildViewingNotesMarkdown(notes);
      fs.writeFileSync(picked.filePath, markdown, 'utf8');
      return { success: true, filePath: picked.filePath, count: notes.length };
    }));

  handle('viewing-note-import', attempt('导入手帐失败', error => ({ error: error.message }),
    async () => {
      const win = pickWindow();
      const options = {
        title: '导入手帐备份',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['openFile']
      };
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true };
      const content = fs.readFileSync(picked.filePaths[0], 'utf8');
      const parsed = parseViewingNotesMarkdown(content);
      if (parsed.error) return { error: parsed.error };
      const result = animeDb.importViewingNotes(parsed.notes);
      return { success: true, ...result };
    }));
}

module.exports = { registerLibraryIpc };
