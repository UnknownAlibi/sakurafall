import { createStore } from 'vuex';
import anime from './modules/anime.js';
import settings from './modules/settings.js';
import player from './modules/player.js';
import notification from './modules/notification.js';
import favorite from './modules/favorite.js';
import download from './modules/download.js';
import reminder from './modules/reminder.js';
import update from './modules/update.js';

// 注：弹幕时间轴对齐模块体积不小且只服务播放器，改由播放器组件按需注册
// （见 Player/DanmakuLayer.vue 的 beforeCreate），避免打进主包常驻体积。

export default createStore({
  modules: {
    anime,
    settings,
    player,
    notification,
    favorite,
    download,
    reminder,
    update
  }
});
