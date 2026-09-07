module.exports = function playbackPressure(windows, getMainWindow) {
  const notify = () => {
    const main = getMainWindow();
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
      main.webContents.send('background-playback-pressure', windows.size > 0);
    }
  };
  return {
    add(window) { windows.add(window); notify(); },
    delete(window) { windows.delete(window); notify(); }
  };
};
