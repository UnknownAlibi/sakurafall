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
          if (id.includes('/components/Player/') || id.includes('\\components\\Player\\')) {
            return 'player-core';
          }
          if (id.includes('/utils/episodePlayback') || id.includes('\\utils\\episodePlayback')) {
            return 'player-utils';
          }
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
