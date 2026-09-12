import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
      port: 3000,
      strictPort: true,
    },
    build: {
      target: 'es2021',
      sourcemap: false,
    },
  };
});
