import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEpisodeIdentity,
  createTimelineAnchor,
  resolveTimelineAnchor
} from '../src/renderer/utils/episodeIdentity.js';
import {
  beginRouteProbe,
  beginRouteSwitch,
  completeRouteProbe,
  createSakuraRouteSession,
  describeSakuraRoute,
  failRouteAttempt,
  markRouteStable
} from '../src/renderer/utils/sakuraRouteSession.js';

test('episode identity stays stable across different playback sources', () => {
  const first = createEpisodeIdentity({
    anime: { bgm_id: 123, name: '樱月物语', sourceId: 'source-a' },
    episode: { title: '第12集', index: 11, id: 'a-12' }
  });
  const second = createEpisodeIdentity({
    anime: { bgmId: 123, name: 'Sakura Moon', sourceId: 'source-b' },
    episode: { title: '12', index: 11, id: 'b-12' }
  });
  assert.equal(first.key, 'bgm:123|ep:12');
  assert.equal(first.key, second.key);
  assert.equal(createEpisodeIdentity({ episodeIdentity: first, anime: { name: '完全不同的源标题' } }).key, first.key);
});

test('timeline anchor uses progress when encode durations materially differ', () => {
  const anchor = createTimelineAnchor(600, 1200);
  assert.equal(resolveTimelineAnchor(anchor, 1205), 600);
  assert.equal(resolveTimelineAnchor(anchor, 1320), 660);
});

test('SakuraRoute session records probing, switching and recovery', () => {
  let route = createSakuraRouteSession({ episodeKey: 'bgm:1|ep:2', sourceId: 'a', sourceName: 'A' });
  route = beginRouteProbe(route);
  assert.equal(route.phase, 'probing');
  route = completeRouteProbe(route, [{ sourceId: 'b' }, { sourceId: 'c' }], [{ sourceId: 'd' }]);
  assert.equal(route.candidateCount, 2);
  route = beginRouteSwitch(route, { sourceId: 'b', sourceName: 'B' }, 321);
  assert.deepEqual(route.attemptedSourceIds, ['b']);
  route = failRouteAttempt(route, new Error('timeout'));
  assert.equal(route.phase, 'degraded');
  route = markRouteStable(route, { sourceId: 'b', sourceName: 'B' });
  assert.equal(route.switchCount, 1);
  assert.equal(describeSakuraRoute(route).label, '已自动换线');
});
