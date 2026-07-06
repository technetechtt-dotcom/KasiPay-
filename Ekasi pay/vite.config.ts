import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  /**
   * Backend target for the /api dev proxy.
   * Override with VITE_API_PROXY=http://example:1234 or BACKEND_PORT=8800.
   */
  const apiTarget =
    env.VITE_API_PROXY ||
    `http://localhost:${env.BACKEND_PORT || '8787'}`

  return {
    base: './',
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            motion: ['framer-motion'],
            icons: ['lucide-react'],
          },
        },
      },
    },
  }
})
