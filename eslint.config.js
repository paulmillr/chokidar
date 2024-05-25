import eslintjs from '@eslint/js';
import globals from 'globals';
import {configs as tseslintConfigs} from 'typescript-eslint';

const {configs: eslintConfigs} = eslintjs;
const files = ['test.mjs', 'src/**/*.ts'];

export default [
  {
    files,
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    ...eslintConfigs.recommended,
    files
  },
  ...tseslintConfigs.strict.map((config) => ({
    ...config,
    files
  })),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off'
    }
  }
];
