import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  build: {
    // 2026-10-23：输出目录从 '../web-dist' 改为 '../web/dist'（旧实现自己的构建位，
    // app.ts resolveWebDist 第三候选：仅当 web-dist 两候选缺席时兜底命中）。原因：live
    // 部署位已由 webapp/（新前端）接管（webapp/scripts/swap-web-dist.sh 换装），旧管线
    // 若仍写 ../web-dist 会 emptyOutDir 清空部署目录——10-23 01:51 实发过一次回滚事故。
    outDir: '../web/dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
