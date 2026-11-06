import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDownloadedTask,
  wrapEpisodeWithLocalDownload
} from '../src/renderer/utils/downloadedEpisodeMatch.js';

test('findDownloadedTask matches completed task by anime id and episode number', () => {
  const downloadList = [
    {
      id: 'task-1',
      status: 'completed',
      playUrl: 'sakurafall-media://asset/token123',
      anime: { id: '607915', name: '凡人修仙传 重制版' },
      episode: { index: 0, title: '第1集' }
    },
    {
      id: 'task-2',
      status: 'downloading',
      playUrl: '',
      anime: { id: '607915', name: '凡人修仙传 重制版' },
      episode: { index: 1, title: '第2集' }
    }
  ];

  const anime = { bgm_id: 607915, name: '凡人修仙传 重制版' };
  const ep1 = { title: '第1集', bangumiEpisodeNumber: 1 };
  const ep2 = { title: '第2集', bangumiEpisodeNumber: 2 };
  const ep3 = { title: '第3集', bangumiEpisodeNumber: 3 };

  const match1 = findDownloadedTask(downloadList, anime, ep1, 0);
  assert.ok(match1);
  assert.equal(match1.id, 'task-1');

  // 未完成的下载不应被匹配为可播本地文件
  const match2 = findDownloadedTask(downloadList, anime, ep2, 1);
  assert.equal(match2, null);

  // 尚未下载的剧集返回 null
  const match3 = findDownloadedTask(downloadList, anime, ep3, 2);
  assert.equal(match3, null);
});

test('findDownloadedTask matches by title and episode text when id differs', () => {
  const downloadList = [
    {
      id: 'task-custom',
      status: 'completed',
      playUrl: 'sakurafall-media://asset/token456',
      anime: { id: 'cms_123', name: '葬送的芙莉莲' },
      episode: { index: 3, title: '第4话 灵魂的居所' }
    }
  ];

  const anime = { bgm_id: 400602, name: '葬送的芙莉莲', name_cn: '葬送的芙莉莲' };
  const ep = { title: '第4集', bangumiEpisodeNumber: 4 };

  const match = findDownloadedTask(downloadList, anime, ep, 3);
  assert.ok(match);
  assert.equal(match.id, 'task-custom');
  assert.equal(match.playUrl, 'sakurafall-media://asset/token456');
});

test('wrapEpisodeWithLocalDownload replaces playback url with local asset url', () => {
  const ep = {
    title: '第1集',
    url: 'https://cdn.example.com/stream.m3u8'
  };
  const task = {
    id: 't1',
    status: 'completed',
    playUrl: 'sakurafall-media://asset/localmp4'
  };

  const wrapped = wrapEpisodeWithLocalDownload(ep, task);
  assert.equal(wrapped.url, 'sakurafall-media://asset/localmp4');
  assert.equal(wrapped.isLocalDownload, true);
  assert.equal(wrapped.originalOnlineUrl, 'https://cdn.example.com/stream.m3u8');

  // 没有 task 时保持原样
  const unchanged = wrapEpisodeWithLocalDownload(ep, null);
  assert.equal(unchanged.url, 'https://cdn.example.com/stream.m3u8');
  assert.equal(unchanged.isLocalDownload, false);
});
