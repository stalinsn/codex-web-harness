import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // Input sanitizers deliberately match control characters.
      'no-control-regex': 'off',
    },
  },
  { files: ['server.mjs', 'src/**/*.mjs', 'test/**/*.mjs', '../scripts/**/*.mjs', 'eslint.config.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser } },
  { files: ['public/service-worker.js'], languageOptions: { sourceType: 'script', globals: globals.serviceworker } },
];
