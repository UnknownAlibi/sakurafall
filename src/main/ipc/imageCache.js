module.exports = function registerImageCache(secureIpcHandle, service) {
  const { owners, getOwner } = require('./requestOwners')();
  secureIpcHandle('image-cache-get-cover', async (event, url, options = {}) => {
    const owner = getOwner(event.sender);
    const { requests } = owner;
    const id = typeof options.requestId === 'string' ? options.requestId.slice(0, 128) : Symbol();
    if (requests.size >= 300 || requests.has(id)) return { success: false, error: 'Cover request limit reached' };
    const request = { controller: new AbortController(), priority: options.priority === 'prefetch' ? 20 : 0 };
    requests.set(id, request);
    try {
      return await service.getCover(url, {
        variant: options.variant, width: options.width,
        signal: request.controller.signal, priority: () => request.priority,
        canRun: () => request.priority === 0 || !owner.paused
      });
    } catch (error) {
      return { success: false, originalUrl: url || '', error: error.message };
    } finally {
      if (requests.get(id) === request) requests.delete(id);
    }
  });
  secureIpcHandle('image-cache-update-request', (event, id, action) => {
    const request = owners.get(event.sender)?.requests.get(id);
    if (!request) return false;
    if (action === 'cancel') request.controller.abort();
    else if (action === 'visible' || action === 'prefetch') request.priority = action === 'visible' ? 0 : 20;
    service.downloadQueue?.pump();
    return true;
  });
  secureIpcHandle('image-cache-set-pressure', (event, paused) => {
    getOwner(event.sender).paused = paused === true;
    service.downloadQueue?.pump();
  });
};
