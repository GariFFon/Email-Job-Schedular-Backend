import {
  pgTable,
  text,
  timestamp,
  integer,
  pgEnum,
  uuid,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';

// ─── Enums ────────────────────────────────────────────────────────────────────
export const emailStatusEnum = pgEnum('email_status', [
  'scheduled',
  'processing',
  'sent',
  'failed',
  'rate_limited',
  'cancelled',
]);

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').unique(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Email Batches ────────────────────────────────────────────────────────────
// Represents a "campaign" / compose action (one batch = one compose)
export const emailBatches = pgTable('email_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name').notNull(),
  totalRecipients: integer('total_recipients').notNull().default(0),
  sentCount: integer('sent_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  delayBetweenEmailsMs: integer('delay_between_emails_ms').notNull().default(2000),
  hourlyLimit: integer('hourly_limit').notNull().default(200),
  scheduledStartAt: timestamp('scheduled_start_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Individual Email Jobs ────────────────────────────────────────────────────
export const emailJobs = pgTable('email_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => emailBatches.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Idempotency key — used as the BullMQ job ID to prevent duplicate enqueuing
  idempotencyKey: text('idempotency_key').notNull().unique(),

  toEmail: text('to_email').notNull(),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),

  status: emailStatusEnum('status').notNull().default('scheduled'),
  scheduledAt: timestamp('scheduled_at').notNull(),
  sentAt: timestamp('sent_at'),
  failedAt: timestamp('failed_at'),
  errorMessage: text('error_message'),
  
  // Ethereal preview URL (for testing)
  etherealPreviewUrl: text('ethereal_preview_url'),

  // BullMQ metadata
  bullJobId: text('bull_job_id'),
  attempts: integer('attempts').notNull().default(0),

  isStarred: boolean('is_starred').notNull().default(false),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Type exports ─────────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type EmailBatch = typeof emailBatches.$inferSelect;
export type NewEmailBatch = typeof emailBatches.$inferInsert;
export type EmailJob = typeof emailJobs.$inferSelect;
export type NewEmailJob = typeof emailJobs.$inferInsert;
export type EmailStatus = (typeof emailStatusEnum.enumValues)[number];
