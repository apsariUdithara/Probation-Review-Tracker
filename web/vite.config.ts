import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, /api/* is forwarded to the backend (npm run dev in the repo root),
// so the browser talks to one origin and no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
