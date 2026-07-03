// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // import 경계: 앱 상호 참조 금지
  {
    files: ['apps/futures/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/spot/**', '**/apps/portal/**', '**/apps/dex/**'],
              message: 'futures 앱은 다른 앱을 import할 수 없다 (공유는 libs/*로)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/spot/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/futures/**', '**/apps/portal/**', '**/apps/dex/**'],
              message: 'spot 앱은 다른 앱을 import할 수 없다 (공유는 libs/*로)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/portal/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/spot/**', '**/apps/futures/**', '**/apps/dex/**'],
              message: 'portal 앱은 다른 앱을 import할 수 없다 (공유는 libs/*로)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/dex/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/spot/**', '**/apps/futures/**', '**/apps/portal/**'],
              message: 'dex 앱은 다른 앱을 import할 수 없다 (공유는 libs/*로)',
            },
          ],
        },
      ],
    },
  },
  // import 경계: libs → apps 금지
  {
    files: ['libs/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/**'],
              message: 'libs는 앱 코드를 import할 수 없다',
            },
          ],
        },
      ],
    },
  },
);
