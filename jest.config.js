// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/etoro/**',      // requires live eToro credentials/browser
    '!src/analysis/ai_chart.js', // requires real Anthropic API + screenshot
    '!src/index.js'       // integration entry point, tested via dry-run
  ],
  coverageThreshold: { global: { lines: 70 } }
};
