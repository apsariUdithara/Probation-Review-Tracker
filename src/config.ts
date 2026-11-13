import { z } from 'zod';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_TIMEZONE: z.string().refine(isValidTimeZone, 'Unknown IANA timezone').default('Asia/Colombo'),
});

export type Config = { databaseUrl: string; port: number; timeZone: string };

// Fails fast at startup with a readable message if the environment is wrong.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment (see .env.example):\n${z.prettifyError(parsed.error)}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    timeZone: parsed.data.APP_TIMEZONE,
  };
}
