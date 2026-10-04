import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: process.env.WEB_BASE_PATH || '/',
  build: { rollupOptions: { input: {
    app: fileURLToPath(new URL('./index.html', import.meta.url)),
    screenTest: fileURLToPath(new URL('./screen-test.html', import.meta.url)),
    screenFixture: fileURLToPath(new URL('./screen-fixture.html', import.meta.url)),
  } } },
  optimizeDeps: {entries: ['index.html']},
  server: {port: 5173, strictPort: true, proxy: {
    '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
    '^/screen/': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
    '/health': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
  }},
});
