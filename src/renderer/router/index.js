import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    redirect: '/anime-zone'
  },
  {
    path: '/anime-zone',
    name: 'anime-zone',
    component: () => import('../views/AnimeZone.vue'),
    meta: {
      title: '番剧库',
      icon: '📺'
    }
  },
  {
    path: '/my-favorites',
    name: 'my-favorites',
    component: () => import('../views/MyFavorites.vue'),
    meta: {
      title: '我的追番',
      icon: '💕'
    }
  },
  {
    path: '/downloads',
    name: 'downloads',
    component: () => import('../views/Downloads.vue'),
    meta: {
      title: '下载管理',
      icon: '⬇'
    }
  },
  {
    path: '/discovery',
    name: 'discovery',
    component: () => import('../views/Discovery.vue'),
    meta: {
      title: '发现',
      icon: '🔍'
    }
  },
  {
    path: '/bt-hub',
    name: 'bt-hub',
    component: () => import('../views/BtHub.vue'),
    meta: {
      title: 'BT 资源站',
      icon: '🧲'
    }
  },
  {
    path: '/video-player',
    name: 'video-player',
    component: () => import('../views/VideoPlayer.vue'),
    meta: {
      title: '视频播放',
      icon: '▶️'
    }
  },
  {
    path: '/player-window',
    name: 'player-window',
    component: () => import('../views/PlayerWindow.vue'),
    meta: {
      title: '播放器',
      isPlayerWindow: true
    }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/Settings.vue'),
    meta: {
      title: '应用设置',
      icon: '⚙️'
    }
  },
  {
    path: '/source-manager',
    name: 'source-manager',
    component: () => import('../views/SourceManager.vue'),
    meta: {
      title: '数据源管理',
      icon: '📡'
    }
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

// 路由守卫
router.beforeEach((to, from, next) => {
  // 设置页面标题
  if (to.meta.title) {
    document.title = `${to.meta.title} - SAKURAFALL`;
  }
  next();
});

export default router;
