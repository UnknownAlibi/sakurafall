module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true
  },
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-essential'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  ignorePatterns: [
    'src/renderer/dist/**',
    'dist/**',
    'dist-app/**',
    'release/**',
    'node_modules/**'
  ],
  rules: {
    'no-console': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_'
    }],
    'vue/multi-word-component-names': 'off',
    'vue/no-reserved-keys': 'off',
    'vue/require-toggle-inside-transition': 'off'
  },
  globals: {
    __dirname: 'readonly'
  }
};
