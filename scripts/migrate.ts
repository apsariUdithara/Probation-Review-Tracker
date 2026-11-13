import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

// The ONLY migration runner: used by `npm run migrate`, the test global setup and CI.
export async function migrate(databaseUrl: string, direction: 'up' | 'down'): Promise<void> {
  await runner({
    databaseUrl,
    dir: join(import.meta.dirname, '..', 'migrations'),
    migrationsTable: 'pgmigrations',
    direction,
    count: direction === 'up' ? Infinity : 1, // up: all pending; down: only the latest
    log: () => {}, // keep test output quiet; the CLI prints its own summary
  });
}

if (import.meta.main) {
  const direction = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (direction !== 'up' && direction !== 'down') {
    console.error('Usage: node scripts/migrate.ts up|down');
    process.exit(1);
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
  }
  await migrate(databaseUrl, direction);
  console.log(`Migrations ${direction}: done`);
}
