import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
