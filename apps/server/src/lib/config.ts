import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  driver: z.enum(['mock', 'webkit']).default('mock'),
  mockNavigateLatencyMs: z.coerce.number().int().nonnegative().default(120),
  mockInteractLatencyMs: z.coerce.number().int().nonnegative().default(40),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    driver: env.DRIVER,
    mockNavigateLatencyMs: env.MOCK_NAVIGATE_LATENCY_MS,
    mockInteractLatencyMs: env.MOCK_INTERACT_LATENCY_MS,
  });
}
