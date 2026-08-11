import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@engine': resolve('src/engine'),
  '@': resolve('src/renderer/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
