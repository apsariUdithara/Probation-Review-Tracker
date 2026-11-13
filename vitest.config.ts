import { defineConfig } from 'vitest/config';

// globalSetup (migrations) and fileParallelism: false are added in Phase 3,
// when the first integration tests need the database.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
