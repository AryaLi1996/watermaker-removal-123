import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    fs: {
      // Allow vitest to load test files from outside the renderer/ root
      allow: ['..'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      '../tests/unit/renderer/**/*.{test,spec}.{ts,tsx}',
    ],
  },
})
