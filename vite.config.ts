/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.{ts,tsx}'] } },
      {
        extends: true,
        test: { name: 'db', include: ['tests/db/**/*.test.ts'], environment: 'node', fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 },
      },
      {
        extends: true,
        test: { name: 'api', include: ['tests/api/**/*.test.ts'], environment: 'node', fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 },
      },
    ],
  },
})
