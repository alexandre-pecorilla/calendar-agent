import { defineConfig } from 'vitest/config';

// Live suites (tests/live) need the owner's .env and real services; they run
// only via `make test-live` (LIVE=1). Everything else is hermetic.
const live = process.env.LIVE === '1';

export default defineConfig({
  test: {
    include: live ? ['tests/live/**/*.test.ts'] : ['tests/{unit,integration,repo}/**/*.test.ts'],
    environment: 'node',
    testTimeout: live ? 1_200_000 : 15_000,
    hookTimeout: 60_000,
    fileParallelism: !live,
  },
});
