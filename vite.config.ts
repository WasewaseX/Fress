import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    clearScreen: false,
    server: {
      port: 3000,
      strictPort: true,
    },
    build: {
      target: 'es2021',
      sourcemap: false,
      rollupOptions: {
        output: {
          // Split by who owns the code. The framework pieces barely change
          // between releases, the catalog data changes often, so keeping
          // them in separate files lets the WebView reuse what it already
          // parsed after an update.
          manualChunks(id: string) {
            if (id.includes('/src/data/')) return 'catalog';
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('lucide-react')) return 'icons';
            if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) {
              return 'react-core';
            }
            return 'vendor';
          },
        },
      },
    },
  };
});
