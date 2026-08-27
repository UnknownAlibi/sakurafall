const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MediaLibraryService } = require('../src/main/services/sources/MediaLibraryService');

test('local media library indexes series without exposing filesystem paths in playback URLs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-media-'));
  const seriesDir = path.join(root, 'Example Anime');
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(path.join(seriesDir, 'Example Anime E01.mp4'), 'video-one');
  fs.writeFileSync(path.join(seriesDir, 'Example Anime E02.mkv'), 'video-two');
  fs.writeFileSync(path.join(seriesDir, 'cover.jpg'), 'cover');

  const service = new MediaLibraryService();
  service.setLibraries([{ id: 'local-anime', name: 'Local Anime', type: 'local', roots: [root] }]);
  const result = await service.search('local-anime', 'Example Anime');

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].episode_count, 2);
  const episodeUrl = result.data[0].episodes['本地媒体'][0].url;
  assert.match(episodeUrl, /^sakurafall-media:\/\/asset\//);
  assert.doesNotMatch(episodeUrl, /Example|Anime|mp4/i);
  assert.ok(service.resolveMediaPath(episodeUrl).startsWith(seriesDir));
  fs.rmSync(root, { recursive: true, force: true });
});

test('media library exports environment references but redacts literal credentials', () => {
  const service = new MediaLibraryService();
  service.setLibraries([
    { id: 'jelly', name: 'Jellyfin', type: 'jellyfin', baseUrl: 'http://127.0.0.1:8096', apiKey: 'literal-secret' },
    { id: 'emby', name: 'Emby', type: 'emby', baseUrl: 'http://127.0.0.1:8097', apiKey: '${ENV:EMBY_KEY}' }
  ]);
  const exported = service.exportLibraries();
  assert.equal(exported[0].apiKey, '');
  assert.equal(exported[1].apiKey, '${ENV:EMBY_KEY}');
});
