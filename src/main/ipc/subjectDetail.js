module.exports = function registerSubjectDetail(secureIpcHandle, service) {
  const { owners, getOwner } = require('./requestOwners')();
  secureIpcHandle('subject-detail', async (event, bgmId, options = {}) => {
    const { requests } = getOwner(event.sender);
    const id = typeof options?.requestId === 'string' ? options.requestId.slice(0, 128) : Symbol();
    if (requests.size >= 100 || requests.has(id)) return null;
    const request = { controller: new AbortController() };
    requests.set(id, request);
    try {
      return await service.getDetail(bgmId, { signal: request.controller.signal });
    } catch (error) {
      if (!request.controller.signal.aborted) console.warn('[Subject] Detail request failed:', error.message);
      return null;
    } finally {
      if (requests.get(id) === request) requests.delete(id);
    }
  });
  secureIpcHandle('subject-detail-cancel', (event, id) => {
    owners.get(event.sender)?.requests.get(id)?.controller.abort();
  });
};
