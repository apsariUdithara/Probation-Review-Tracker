import { createApp } from './app.ts';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp({ pool, clock: systemClock(config.timeZone) });

// Express 5 passes startup errors (e.g. port already in use) to this callback.
const server = app.listen(config.port, (err) => {
  if (err) {
    console.error(`Could not start the server on port ${config.port}: ${err.message}`);
    process.exitCode = 1;
    void pool.end();
    return;
  }
  console.log(`Probation Review Tracker listening on http://localhost:${config.port} (${config.timeZone})`);
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => void pool.end());
  });
}
