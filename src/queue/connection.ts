// src/queue/connection.ts
import { Redis, type RedisOptions } from 'ioredis';

export function redisConnectionOptions(url: string): RedisOptions {
  if (!url.startsWith('redis://') && !url.startsWith('rediss://')) {
    throw new Error(`REDIS_URL must include a redis:// or rediss:// scheme; got: ${url}`);
  }
  const parsed = new URL(url);
  const opts: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    // BullMQ requirement — must be null to avoid connection timeout errors.
    maxRetriesPerRequest: null,
  };
  if (parsed.password) opts.password = parsed.password;
  if (parsed.username) opts.username = parsed.username;
  return opts;
}

let singleton: Redis | null = null;

export function getRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): Redis {
  if (!singleton) singleton = new Redis(redisConnectionOptions(url));
  return singleton;
}

export async function closeRedis(): Promise<void> {
  if (singleton) {
    await singleton.quit();
    singleton = null;
  }
}
