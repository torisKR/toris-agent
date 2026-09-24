import { defineConfig } from 'vite';

// Tauri serves the built assets from a custom protocol, so relative paths are
// required. `clearScreen:false` keeps Tauri's Rust logs visible during dev.
export default defineConfig({
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2021',
    sourcemap: false,
  },
});
