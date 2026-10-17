import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    server: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
    },
    plugins: [react(), tailwindcss()],
  },
});
