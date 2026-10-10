import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
