import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'skills/**', 'bun.lock'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: {
        Response: 'readonly',
        URL: 'readonly',
        process: 'readonly'
      }
    }
  }
);
