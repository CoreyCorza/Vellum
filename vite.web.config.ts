import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Browser-only dev server: `npm run dev:web`.
 *
 * The renderer never imports Electron directly — everything native goes through
 * `platform.ts`, which falls back to browser APIs. So the whole editor runs in a
 * plain tab, which is a much faster loop for UI and brush-feel work than
 * restarting Electron. Use `npm run dev` when you need the real shell.
 */
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@engine': resolve('src/engine'),
      '@': resolve('src/renderer/src')
    }
  },
  plugins: [react()],
  server: { port: 5180, open: true }
})
