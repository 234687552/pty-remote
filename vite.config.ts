import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(() => {
  const watchMode = process.argv.includes('--watch');

  return {
    root: path.resolve(__dirname, 'web'),
    base: '/build/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'web/src'),
        '@shared': path.resolve(__dirname, 'shared')
      }
    },
    build: {
      outDir: path.resolve(__dirname, 'public/build'),
      // Keep previous hashed chunks during watch rebuilds so pages that are
      // already open can still resolve lazy imports like mermaid before reload.
      emptyOutDir: !watchMode
    }
  };
});
