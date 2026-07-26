import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from './env';
import * as schema from '../database/schema';

const isSSL = env.DATABASE_URL.includes('sslmode=require') || env.DATABASE_URL.includes('neon.tech');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

export const db = drizzle(pool, { schema });

export async function testDatabaseConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } finally {
    client.release();
  }
}
