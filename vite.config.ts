import { defineConfig } from 'vite';
import pkg from './package.json';
export default defineConfig({
  base: '/MonkeyBrains/',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2020' },
});
