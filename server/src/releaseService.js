const path = require('node:path');
const { safeFileName, sendJson, serveFile } = require('./httpUtils');

class ReleaseService {
  constructor(releaseDir) {
    this.releaseDir = releaseDir;
  }

  handle(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    if (url.pathname === '/updates/latest.json') {
      const served = serveFile(req, res, path.join(this.releaseDir, 'latest.json'), 'application/json; charset=utf-8');
      if (!served) sendJson(res, 404, { error: 'release_manifest_not_found' });
      return true;
    }
    if (url.pathname.startsWith('/downloads/')) {
      const fileName = safeFileName(decodeURIComponent(url.pathname.slice('/downloads/'.length)));
      if (!fileName || !serveFile(req, res, path.join(this.releaseDir, fileName))) {
        sendJson(res, 404, { error: 'download_not_found' });
      }
      return true;
    }
    return false;
  }
}

module.exports = { ReleaseService };
