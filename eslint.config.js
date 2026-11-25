import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';

const MATH_ALLOWED =
  'floor|ceil|round|trunc|abs|sign|sqrt|min|max|imul|fround|clz32';

const engineSyntaxRules = [
  {
    selector: `MemberExpression[object.name='Math'][property.name!=/^(${MATH_ALLOWED})$/]`,
    message:
      'Only floor, ceil, round, trunc, abs, sign, sqrt, min, max, imul, fround and clz32 are allowed on Math in engine code. Use engine/math/detmath.js (PI, fastExp, fastAtan2, sigmoid).',
  },
  {
    selector: "MemberExpression[object.name='Math'][computed=true]",
    message: 'Computed access on Math is banned in engine code.',
  },
  {
    selector: "BinaryExpression[operator='**']",
    message: 'The ** operator is banned in engine code (not bit-identical across engines).',
  },
  {
    selector: "AssignmentExpression[operator='**=']",
    message: 'The **= operator is banned in engine code (not bit-identical across engines).',
  },
  {
    selector:
      'CallExpression[callee.property.name=/^(localeCompare|toLocaleString|toLocaleUpperCase|toLocaleLowerCase)$/]',
    message: 'Locale-dependent string methods are banned in engine code.',
  },
  {
    selector: "Identifier[name='Math']:not(MemberExpression[object.name='Math'] > Identifier.object)",
    message: 'Aliasing Math is banned in engine code; use Math.<allowed member> directly.',
  },
];

export default [
  {
    ignores: [
      'dist/**',
      '.vite/**',
      'generated/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
      'android/**',
      'node_modules/**',
      '.cache/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['*.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/ui/**/*.js', 'src/runtime/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**/*.{js,mjs}', 'src/calibration/**/*.js', 'tests/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Shared helpers run in both Node and the browser.
    files: ['src/shared/**/*.js', 'src/i18n/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['src/engine/**/*.js'],
    plugins: { import: importPlugin },
    rules: {
      'no-restricted-syntax': ['error', ...engineSyntaxRules],
      'no-restricted-globals': [
        'error',
        ...['Date', 'performance', 'Intl', 'globalThis', 'window', 'document', 'process', 'require'].map(
          (name) => ({ name, message: `${name} is banned in engine code (determinism and G2 boundary).` }),
        ),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', '#*'], message: 'engine imports only relative engine modules' },
            { regex: '^(?![./])', message: 'engine imports only relative engine modules' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.js'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './src/engine', from: './src', except: ['./engine'] },
            { target: './src/engine', from: './generated' },
            { target: './src/runtime', from: './src/ui' },
          ],
        },
      ],
    },
  },
];
