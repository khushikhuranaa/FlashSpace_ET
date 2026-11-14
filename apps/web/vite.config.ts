import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, so the Pages workflow sets
  // VITE_BASE=/<repo>/. Default '/' keeps local dev, Docker and root-hosted
  // deployments (Render, custom domains) byte-for-byte unchanged.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      // Local storage returns relative signed URLs (`/storage-upload?token=…`).
      // Proxy them to the API so uploads/downloads stay same-origin in dev.
      '/storage-upload': 'http://localhost:4000',
      '/storage-download': 'http://localhost:4000',
    },
  },
});
