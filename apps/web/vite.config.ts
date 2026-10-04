import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.WEB_BASE_PATH || '/',
  optimizeDeps: {entries: ['index.html']},
  server: {port: 5173, strictPort: true, proxy: {
    '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
    '/screen': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
    '/health': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
  }},
});
