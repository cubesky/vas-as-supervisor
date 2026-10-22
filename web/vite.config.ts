import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const backend = process.env.VAS_DEV_BACKEND || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [preact()],
  // noVNC uses top-level await
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    port: 5173,
    proxy: {
      // keep the browser's Origin so passkeys verify against the dev origin
      '/api': { target: backend, ws: true, changeOrigin: false },
    },
  },
});
