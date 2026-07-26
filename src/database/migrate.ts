import { Pool } from 'pg';
import { env } from '../config/env';

const isSSL = env.DATABASE_URL.includes('sslmode=require') || env.DATABASE_URL.includes('neon.tech');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isSSL ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  console.log('🗄️  Running database migrations...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create email_status enum
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE email_status AS ENUM (
          'scheduled', 'processing', 'sent', 'failed', 'rate_limited', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        google_id TEXT UNIQUE,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        avatar TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Email batches table
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_batches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        from_email TEXT NOT NULL,
        from_name TEXT NOT NULL,
        total_recipients INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        delay_between_emails_ms INTEGER NOT NULL DEFAULT 2000,
        hourly_limit INTEGER NOT NULL DEFAULT 200,
        scheduled_start_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Email jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id UUID NOT NULL REFERENCES email_batches(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        to_email TEXT NOT NULL,
        from_email TEXT NOT NULL,
        from_name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status email_status NOT NULL DEFAULT 'scheduled',
        scheduled_at TIMESTAMP NOT NULL,
        sent_at TIMESTAMP,
        failed_at TIMESTAMP,
        error_message TEXT,
        ethereal_preview_url TEXT,
        bull_job_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        is_starred BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_jobs_status ON email_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_email_jobs_user_id ON email_jobs(user_id);
      CREATE INDEX IF NOT EXISTS idx_email_jobs_batch_id ON email_jobs(batch_id);
      CREATE INDEX IF NOT EXISTS idx_email_jobs_scheduled_at ON email_jobs(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_email_jobs_idempotency ON email_jobs(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_email_batches_user_id ON email_batches(user_id);
    `);

    await client.query('COMMIT');
    console.log('✅ Migrations completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
