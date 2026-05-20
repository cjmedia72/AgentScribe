// auth-detector.test.js
// CommonJS loader shim — defers to the .mjs ES module test runner.
// Required because the AgentScribe extension has no package.json with type:module,
// so .js files cannot use ES module import syntax directly under Node.
// Run: node tests/wave2/auth-detector.test.js

import('./auth-detector.test.mjs').catch((err) => {
  console.error('Failed to load auth-detector.test.mjs:', err);
  process.exit(1);
});
