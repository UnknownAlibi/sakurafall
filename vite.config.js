import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html')
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('hls.js')) return 'player-hls';
            if (id.includes('vue') || id.includes('vue-router') || id.includes('vuex')) return 'vue-vendor';
            return 'vendor';
          }
          // 不要按业务目录强制分组。Vue SFC 编译产出的共享 helper 会被卷进该目录
          // 所在的 chunk，使入口与其它路由 chunk 反向依赖它，从而把播放器代码
          // 推上首屏关键路径。交给 Rollup 按动态 import 边界自动分包即可。
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  worker: {
    format: 'es',
  },
  // Electron 环境配置
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
  },
});
