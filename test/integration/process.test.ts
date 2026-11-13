import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// These tests start real Node processes, because the behaviour under test is how a process
// starts and exits. No test here writes to a database.

const ROOT = join(import.meta.dirname, '..', '..');
const TIMEOUT = 15_000;

type Result = { code: number | null; stdout: string; stderr: string };

function run(script: string, env: Record<string, string>, onStart?: (child: ChildProcess) => void): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    onStart?.(child);
  });
}

async function occupyPort(): Promise<{ port: number; release: () => void }> {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, resolve));
  return { port: (blocker.address() as AddressInfo).port, release: () => blocker.close() };
}

describe('server process', () => {
  // Regression: the server used to print "listening" and exit with code 0.
  it(
    'exits with a clear error and code 1 when the port is already in use',
    async () => {
      const { port, release } = await occupyPort();
      try {
        const result = await run('src/server.ts', {
          PORT: String(port),
          DATABASE_URL: process.env.TEST_DATABASE_URL!,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`Could not start the server on port ${port}`);
        expect(result.stdout).not.toContain('listening');
      } finally {
        release();
      }
    },
    TIMEOUT,
  );

  // Windows cannot deliver SIGTERM to a child process, so this runs on Linux/macOS (CI).
  it.skipIf(process.platform === 'win32')(
    'shuts down cleanly on SIGTERM',
    async () => {
      const { port, release } = await occupyPort();
      release(); // a port that was free a moment ago
      const result = await run(
        'src/server.ts',
        { PORT: String(port), DATABASE_URL: process.env.TEST_DATABASE_URL! },
        (child) => {
          child.stdout!.on('data', (chunk) => {
            if (String(chunk).includes('listening')) child.kill('SIGTERM');
          });
        },
      );
      expect(result.stdout).toContain('SIGTERM received, shutting down');
      expect(result.code).toBe(0);
    },
    TIMEOUT,
  );
});

describe('seed safety guard', () => {
  // The guard runs before connecting, so these never touch a database.
  it.each([
    ['a remote database', 'postgres://user:pass@db.example.com:5432/probation'],
    ['the test database', 'postgres://user:pass@localhost:5432/probation_test'],
  ])(
    'refuses to run against %s',
    async (_case, url) => {
      const result = await run('scripts/seed.ts', { DATABASE_URL: url });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Refusing to seed');
    },
    TIMEOUT,
  );
});
