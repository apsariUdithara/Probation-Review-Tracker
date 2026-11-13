import { migrate } from '../scripts/migrate.ts';

// Runs once before the integration tests: same migration code as dev and CI.
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env)');

  // Tests TRUNCATE every table, so never point them at a real database by mistake.
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}": the name must end in _test`);
  }

  await migrate(url, 'up');
}
