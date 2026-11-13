import { expect, it } from 'vitest';

// Proves the toolchain runs. Deleted in Phase 2 when real unit tests exist.
it('runs TypeScript tests', () => {
  const sum: number = 1 + 1;
  expect(sum).toBe(2);
});
