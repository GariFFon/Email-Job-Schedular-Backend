import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3001').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_PASSWORD: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:3001/api/auth/google/callback'),

  // Frontend
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // Worker settings
  WORKER_CONCURRENCY: z.string().default('5').transform(Number),
  MIN_DELAY_BETWEEN_EMAILS_MS: z.string().default('2000').transform(Number),

  // Rate limiting
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.string().default('200').transform(Number),

  // Ethereal (optional — auto-generated if empty)
  ETHEREAL_USER: z.string().optional(),
  ETHEREAL_PASS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
