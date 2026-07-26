import { getRedisClient } from '../config/redis';

/**
 * Rate Limiter using Redis atomic Lua script.
 *
 * Strategy:
 * - Key format: rate_limit:{senderEmail}:{YYYY-MM-DD-HH}
 * - Each key has a 1-hour TTL
 * - Atomic check-and-increment via Lua to be safe across multiple workers
 *
 * When limit is exceeded:
 * - Returns { allowed: false, retryAfterMs: <ms until next hour> }
 * - Jobs should be re-delayed by retryAfterMs (NOT dropped)
 */

// Lua script: atomically increment counter and check against limit
// Returns 1 if allowed (under limit), 0 if denied (over limit)
const ATOMIC_INCREMENT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])

local current = redis.call('GET', key)
if current == false then
  -- First request in this window
  redis.call('SET', key, 1, 'EX', ttl_seconds)
  return 1
end

current = tonumber(current)
if current >= limit then
  -- Limit exceeded
  return 0
end

-- Increment within limit
redis.call('INCR', key)
return 1
`;

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  retryAfterMs: number; // ms until start of next hour window
}

/**
 * Check and consume one slot in the hourly rate limit for a sender.
 */
export async function checkAndConsumeRateLimit(
  senderEmail: string,
  hourlyLimit: number,
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  const now = new Date();

  // Key window: sender:YYYY-MM-DD-HH (UTC hour)
  const hourKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}`;
  const redisKey = `rate_limit:${senderEmail}:${hourKey}`;

  // TTL: seconds until end of current UTC hour + 60s buffer
  const minutesInCurrentHour = now.getUTCMinutes();
  const secondsInCurrentHour = now.getUTCSeconds();
  const secondsRemainingInHour = (59 - minutesInCurrentHour) * 60 + (60 - secondsInCurrentHour);
  const ttlSeconds = secondsRemainingInHour + 60;

  // Atomic check-and-increment
  const result = await redis.eval(
    ATOMIC_INCREMENT_SCRIPT,
    1,
    redisKey,
    String(hourlyLimit),
    String(ttlSeconds),
  ) as number;

  // Get current count for response
  const currentCountStr = await redis.get(redisKey);
  const currentCount = parseInt(currentCountStr || '0', 10);

  // Calculate ms until start of next hour
  const nextHourStart = new Date(now);
  nextHourStart.setUTCMinutes(0, 0, 0);
  nextHourStart.setUTCHours(nextHourStart.getUTCHours() + 1);
  const retryAfterMs = nextHourStart.getTime() - now.getTime();

  return {
    allowed: result === 1,
    currentCount,
    limit: hourlyLimit,
    retryAfterMs,
  };
}

/**
 * Get current rate limit status without consuming a slot.
 */
export async function getRateLimitStatus(
  senderEmail: string,
  hourlyLimit: number,
): Promise<{ currentCount: number; limit: number; resetAt: Date }> {
  const redis = getRedisClient();
  const now = new Date();
  const hourKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}`;
  const redisKey = `rate_limit:${senderEmail}:${hourKey}`;

  const countStr = await redis.get(redisKey);
  const currentCount = parseInt(countStr || '0', 10);

  const resetAt = new Date(now);
  resetAt.setUTCMinutes(0, 0, 0);
  resetAt.setUTCHours(resetAt.getUTCHours() + 1);

  return { currentCount, limit: hourlyLimit, resetAt };
}
