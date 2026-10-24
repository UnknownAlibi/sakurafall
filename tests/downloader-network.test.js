const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Downloader = require('../src/main/services/Downloader');

function makeDownloader() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-downloader-'));
  const downloader = new Downloader({
    downloadDir: dir,
    stateFile: path.join(dir, 'downloads.json')
  });
  return { dir, downloader };
}

test('Downloader: setProxy 同步到清单客户端和流式请求 agent', () => {
  const { dir, downloader } = makeDownloader();
  try {
    downloader.setProxy('http://127.0.0.1:7890');
    assert.equal(downloader.proxy, 'http://127.0.0.1:7890');
    assert.equal(downloader._manifestClient.proxy, 'http://127.0.0.1:7890');
    assert.ok(downloader._requestAgent(), '流式下载应使用代理 agent');

    downloader.setProxy('');
    assert.equal(downloader.proxy, '');
    assert.equal(downloader._manifestClient.proxy, '');
    assert.equal(downloader._requestAgent(), null);
  } finally {
    downloader.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Downloader: 直链下载遇到重定向循环时在有限次数内失败', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { dir, downloader } = makeDownloader();
  const target = path.join(dir, 'redirect-loop.bin');
  try {
    await assert.rejects(
      downloader._downloadFile(
        `http://127.0.0.1:${server.address().port}/loop`,
        target,
        { _abortFlag: false, downloadedBytes: 0, totalBytes: 0, progress: 0 }
      ),
      /重定向次数超过上限/
    );
    assert.equal(fs.existsSync(target), false, '重定向失败不应留下半截文件');
  } finally {
    downloader.shutdown();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
