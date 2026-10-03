import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// index.html builds absolute OG/canonical URLs from %VITE_APP_URL% (APP_URL, the same setting the server reads, unless
// overridden); drop a trailing slash and fall back to local dev.
process.env.VITE_APP_URL = (process.env.VITE_APP_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

export default defineConfig({
  resolve: { alias: { '@airhockey/shared': fileURLToPath(new URL('../shared/src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 760,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
