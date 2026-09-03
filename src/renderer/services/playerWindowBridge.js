import { toIpcPlainObject } from '../utils/ipcPayload.js';

export async function openPlayerPreparation(api, { title, episode, lineId, stage = '' }) {
  if (!api?.openPlayerWindow) return null;
  const opened = await api.openPlayerWindow({
    pending: true,
    title,
    stage,
    episodeId: episode?.id || episode?.url || '',
    lineId: lineId || ''
  });
  return opened?.windowId || null;
}

export async function updatePlayerPreparation(api, windowId, data) {
  if (!windowId || !api?.updatePlayerWindow) return false;
  const result = await api.updatePlayerWindow(windowId, toIpcPlainObject(data, {}));
  return result?.success === true;
}

export function closePlayerPreparation(api, windowId) {
  if (!windowId || !api?.closePlayerWindow) return Promise.resolve(false);
  return api.closePlayerWindow(windowId);
}
