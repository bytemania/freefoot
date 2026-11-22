import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  base: './',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      // Only the app page is bundled; the e2e page (src/ui/e2e) is served in dev only.
      input: fileURLToPath(new URL('./src/ui/index.html', import.meta.url)),
    },
  },
});
