import { createApp } from './app.ts';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp({ pool, clock: systemClock(config.timeZone) });

app.listen(config.port, () => {
  console.log(`Probation Review Tracker listening on http://localhost:${config.port} (${config.timeZone})`);
});
