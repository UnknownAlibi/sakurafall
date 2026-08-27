const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adaptXPathRule,
  isXPathRule
} = require('../src/main/services/sources/XPathRuleAdapter');
const { SourcePluginManager } = require('../src/main/services/SourcePluginManager');
const { SourceRuleEngine } = require('../src/main/services/SourceRuleEngine');

const XPATH_RULE = {
  api: '5',
  type: 'anime',
  name: 'ExampleDM',
  version: '1.2',
  useWebview: true,
  useNativePlayer: true,
  adBlocker: true,
  baseURL: 'https://example.com/',
  searchURL: 'https://example.com/search?wd=@keyword',
  searchList: '//ul/li',
  searchName: '//h2/a',
  searchResult: '//h2/a',
  chapterRoads: '//div[@class="roads"]/ul',
  chapterResult: '//li/a'
};

test('community XPath rules are converted to the internal source format', () => {
  assert.equal(isXPathRule(XPATH_RULE), true);
  const rule = adaptXPathRule(XPATH_RULE);

  assert.equal(rule.id, 'xpath-exampledm');
  assert.equal(rule.search.name, './/h2/a');
  assert.equal(rule.search.urlPath, './/h2/a/@href');
  assert.equal(rule.detail.episodeList, './/li/a');
  assert.equal(rule.detail.episodeUrl, './@href');
  assert.equal(rule.playback.mode, 'webview-sniff');
  assert.equal(rule.adBlocker, true);
});

test('plugin import accepts a single community XPath rule document', () => {
  const manager = new SourcePluginManager();
  const result = manager.importRules(JSON.stringify(XPATH_RULE));

  assert.equal(result.success, true);
  assert.equal(result.format, 'xpath');
  assert.equal(result.converted, 1);
  assert.equal(result.added, 1);
  assert.equal(manager.getRule('xpath-exampledm').compatibility.family, 'xpath');
});

test('converted XPath rules parse search results and episode links', async () => {
  const engine = new SourceRuleEngine({
    httpClient: {
      fetch: async url => url.includes('/search')
        ? '<html><body><ul><li><h2><a href="/anime/1">Example Anime</a></h2></li></ul></body></html>'
        : '<html><body><div class="roads"><ul><li><a href="/play/1">Episode 1</a></li><li><a href="/play/2">Episode 2</a></li></ul></div></body></html>'
    }
  });
  const validated = engine.validateRule(XPATH_RULE);
  assert.equal(validated.valid, true);

  const search = await engine.search(validated.rule, 'Example');
  assert.equal(search.success, true);
  assert.equal(search.data[0].name, 'Example Anime');
  assert.equal(search.data[0].url, 'https://example.com/anime/1');

  const detail = await engine.parseDetail(validated.rule, search.data[0].url);
  assert.equal(detail.success, true);
  assert.deepEqual(detail.episodes.map(episode => episode.title), ['Episode 1', 'Episode 2']);
  assert.equal(detail.episodes[0].url, 'https://example.com/play/1');
});