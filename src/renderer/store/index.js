import { createStore } from 'vuex';
import anime from './modules/anime.js';
import settings from './modules/settings.js';
import player from './modules/player.js';
import notification from './modules/notification.js';
import favorite from './modules/favorite.js';
import download from './modules/download.js';
import reminder from './modules/reminder.js';

export default createStore({
  modules: {
    anime,
    settings,
    player,
    notification,
    favorite,
    download,
    reminder
  }
});
