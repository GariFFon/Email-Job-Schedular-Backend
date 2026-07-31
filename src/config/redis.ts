import IORedis, { RedisOptions } from 'ioredis';
import { env } from './env';

let redisClient: IORedis | null = null;

function getRedisOptions(lazyConnect = false): RedisOptions {
  const baseOpts: RedisOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,    // Required by BullMQ
    lazyConnect,
    family: 0,                  // Required for Upstash with Node.js 18+
  };

  // Upstash requires TLS whether the URL is redis:// or rediss://
  // Always enable TLS when connecting to upstash.io
  const url = env.REDIS_URL || '';
  const isUpstash = url.includes('upstash.io');
  const isTLSScheme = url.startsWith('rediss://');

  if (isUpstash || isTLSScheme) {
    baseOpts.tls = { rejectUnauthorized: false };
  }

  return baseOpts;
}

export function getRedisClient(): IORedis {
  if (!redisClient) {
    const opts = getRedisOptions(false);
    if (env.REDIS_URL) {
      redisClient = new IORedis(env.REDIS_URL, opts);
    } else {
      redisClient = new IORedis({
        ...opts,
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        password: env.REDIS_PASSWORD || undefined,
      });
    }

    redisClient.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });

    redisClient.on('reconnecting', () => {
      console.log('🔄 Redis reconnecting...');
    });
  }

  return redisClient;
}

/** Separate connection for BullMQ (must not be shared with other commands) */
export function createBullMQConnection(): IORedis {
  const opts = getRedisOptions(false);
  if (env.REDIS_URL) {
    return new IORedis(env.REDIS_URL, opts);
  }
  return new IORedis({
    ...opts,
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
  });
}
