module.exports = function createRequestOwners() {
  const owners = new Map();
  const getOwner = sender => {
    if (owners.has(sender)) return owners.get(sender);
    const owner = { requests: new Map(), paused: false };
    const clear = () => {
      for (const request of owner.requests.values()) request.controller.abort();
      owner.requests.clear();
    };
    sender.on('render-process-gone', clear);
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) clear();
    });
    sender.once('destroyed', () => { clear(); owners.delete(sender); });
    owners.set(sender, owner);
    return owner;
  };
  return { owners, getOwner };
};
