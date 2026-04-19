import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/index.ts',
  outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
  sourcemap: true,
});
