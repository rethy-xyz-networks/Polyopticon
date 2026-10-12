'use strict';

// Performance measurements (tests/perf): `npm run test:perf`. Separate from the
// regular suite because timings depend on the machine.

const base = require('./playwright.config');
module.exports = { ...base, testDir: 'tests/perf', testMatch: '**/*.perf.js', retries: 0, reporter: 'list' };
