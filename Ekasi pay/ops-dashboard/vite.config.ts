import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/ops-api': 'http://localhost:8790',
      '/health': 'http://localhost:8790',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
