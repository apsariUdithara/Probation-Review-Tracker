import { defineConfig } from 'vitest/config';

// Env vars come from `node --env-file-if-exists=.env` in the npm scripts, not from here.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          fileParallelism: false, // files share one test database
        },
      },
    ],
  },
});
