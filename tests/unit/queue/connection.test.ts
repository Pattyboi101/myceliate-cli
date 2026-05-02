// tests/unit/queue/connection.test.ts
import { describe, expect, it } from 'vitest';
import { redisConnectionOptions } from '../../../src/queue/connection.js';

describe('redisConnectionOptions', () => {
  it('parses REDIS_URL into ioredis-compatible options', () => {
    const opts = redisConnectionOptions('redis://localhost:6379');
    expect(opts).toMatchObject({ host: 'localhost', port: 6379, maxRetriesPerRequest: null });
  });

  it('honours auth in the URL', () => {
    const opts = redisConnectionOptions('redis://:secret@db.internal:6380');
    expect(opts).toMatchObject({ host: 'db.internal', port: 6380, password: 'secret' });
  });

  it('throws on missing scheme', () => {
    expect(() => redisConnectionOptions('localhost:6379')).toThrow(/scheme/i);
  });

  it('accepts rediss:// scheme', () => {
    const opts = redisConnectionOptions('rediss://secure.redis.internal:6380');
    expect(opts).toMatchObject({
      host: 'secure.redis.internal',
      port: 6380,
      maxRetriesPerRequest: null,
    });
  });

  it('honours explicit username and password', () => {
    const opts = redisConnectionOptions('redis://myuser:mypassword@cache.internal:6379');
    expect(opts).toMatchObject({
      host: 'cache.internal',
      port: 6379,
      username: 'myuser',
      password: 'mypassword',
    });
  });

  it('defaults to port 6379 when no port is specified in the URL', () => {
    const opts = redisConnectionOptions('redis://localhost');
    expect(opts).toMatchObject({ host: 'localhost', port: 6379 });
  });
});
