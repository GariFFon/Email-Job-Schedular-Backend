import { Worker, Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { createBullMQConnection } from '../config/redis';
import { db } from '../config/database';
import { emailJobs } from '../database/schema';
import { sendEmail } from '../services/emailService';
import { checkAndConsumeRateLimit } from '../services/rateLimiter';
import { enqueueEmailJob } from './emailQueue';
import { env } from '../config/env';
import { EMAIL_QUEUE_NAME } from './emailQueue';
import type { EmailJobData } from '../types';

let worker: Worker<EmailJobData> | null = null;

export function startEmailWorker(): Worker<EmailJobData> {
  if (worker) return worker;

  console.log(`🚀 Starting email worker (concurrency: ${env.WORKER_CONCURRENCY})`);

  worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      const data = job.data;
      console.log(`📨 Processing job ${job.id} → ${data.toEmail}`);

      // ── Step 1: Idempotency check ─────────────────────────────────────────
      // Fetch current DB status to prevent duplicate sends
      const dbJob = await db.query.emailJobs.findFirst({
        where: eq(emailJobs.id, data.emailJobId),
      });

      if (!dbJob) {
        console.warn(`⚠️  Job ${job.id}: DB record not found, skipping`);
        return;
      }

      if (dbJob.status === 'sent') {
        console.log(`⏭️  Job ${job.id}: Already sent, skipping (idempotent)`);
        return;
      }

      if (dbJob.status === 'cancelled') {
        console.log(`⏭️  Job ${job.id}: Cancelled, skipping`);
        return;
      }

      // ── Step 2: Mark as processing ────────────────────────────────────────
      await db
        .update(emailJobs)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(emailJobs.id, data.emailJobId));

      // ── Step 3: Rate limit check ──────────────────────────────────────────
      const rateLimit = await checkAndConsumeRateLimit(
        data.fromEmail,
        data.hourlyLimit,
      );

      if (!rateLimit.allowed) {
        console.log(
          `🚦 Rate limit reached for ${data.fromEmail} (${rateLimit.currentCount}/${rateLimit.limit}). Rescheduling in ${Math.round(rateLimit.retryAfterMs / 1000 / 60)} min.`,
        );

        // Re-schedule to the next hour window (preserve order by adding small offset)
        await db
          .update(emailJobs)
          .set({
            status: 'rate_limited',
            updatedAt: new Date(),
            scheduledAt: new Date(Date.now() + rateLimit.retryAfterMs),
          })
          .where(eq(emailJobs.id, data.emailJobId));

        // Re-enqueue with delay to next hour
        await enqueueEmailJob(
          { ...data, idempotencyKey: `${data.idempotencyKey}_retry_${Date.now()}` },
          rateLimit.retryAfterMs,
        );

        return; // Don't throw — job is handled (rescheduled)
      }

      // ── Step 4: Enforce minimum delay between sends ───────────────────────
      // BullMQ limiter handles concurrency, but we also add a minimum delay
      // for provider throttling simulation
      if (env.MIN_DELAY_BETWEEN_EMAILS_MS > 0) {
        await sleep(env.MIN_DELAY_BETWEEN_EMAILS_MS);
      }

      // ── Step 5: Send email ────────────────────────────────────────────────
      try {
        const result = await sendEmail({
          toEmail: data.toEmail,
          fromEmail: data.fromEmail,
          fromName: data.fromName,
          subject: data.subject,
          body: data.body,
        });

        // Mark as sent
        await db
          .update(emailJobs)
          .set({
            status: 'sent',
            sentAt: new Date(),
            etherealPreviewUrl: result.previewUrl,
            updatedAt: new Date(),
            attempts: (dbJob.attempts ?? 0) + 1,
          })
          .where(eq(emailJobs.id, data.emailJobId));

        // Update batch sent count
        await db.execute(
          sql`UPDATE email_batches SET sent_count = sent_count + 1 WHERE id = ${data.batchId}`,
        );

        console.log(`✅ Email sent to ${data.toEmail} | Preview: ${result.previewUrl}`);
      } catch (sendError) {
        const errorMsg = sendError instanceof Error ? sendError.message : String(sendError);
        console.error(`❌ Failed to send to ${data.toEmail}:`, errorMsg);

        // Let BullMQ retry mechanism handle it (throw error)
        throw sendError;
      }
    },
    {
      connection: createBullMQConnection(),
      concurrency: env.WORKER_CONCURRENCY,
      // BullMQ rate limiter: max N jobs per duration (secondary guard)
      limiter: {
        max: env.WORKER_CONCURRENCY,
        duration: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      },
    },
  );

  // ── Event handlers ─────────────────────────────────────────────────────────
  worker.on('failed', async (job, err) => {
    if (!job) return;
    const data = job.data;

    console.error(`❌ Job ${job.id} failed after ${job.attemptsMade} attempts:`, err.message);

    // If all retries exhausted, mark as failed in DB
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      await db
        .update(emailJobs)
        .set({
          status: 'failed',
          failedAt: new Date(),
          errorMessage: err.message,
          updatedAt: new Date(),
          attempts: job.attemptsMade,
        })
        .where(eq(emailJobs.id, data.emailJobId));

      // Update batch failed count
      await db.execute(
        sql`UPDATE email_batches SET failed_count = failed_count + 1 WHERE id = ${data.batchId}`,
      );
    }
  });

  worker.on('error', (err) => {
    console.error('❌ Worker error:', err.message);
  });

  worker.on('ready', () => {
    console.log('✅ Email worker ready');
  });

  return worker;
}

export async function stopEmailWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('🛑 Email worker stopped');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
