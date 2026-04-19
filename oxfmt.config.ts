import { defineConfig } from 'oxfmt';

export default defineConfig({
  ignorePatterns: ['dist/**', 'coverage/**'],
  printWidth: 160,
  singleQuote: true,
  sortImports: true,
});
