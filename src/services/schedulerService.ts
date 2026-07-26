import { eq, desc, asc, count, and, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/database';
import { emailBatches, emailJobs } from '../database/schema';
import { enqueueEmailJob } from '../queues/emailQueue';
import type {
  ScheduleEmailRequest,
  EmailJobResponse,
  EmailBatchResponse,
  PaginatedResponse,
  StatsResponse,
} from '../types';

/**
 * Schedule a batch of emails.
 * 
 * For each recipient:
 * 1. Create a DB record with status='scheduled'
 * 2. Enqueue a BullMQ delayed job using idempotencyKey as jobId
 * 
 * Staggered delays: each email gets an incremental offset based on
 * the per-email delay setting, so they don't all fire simultaneously.
 */
export async function scheduleEmailBatch(
  userId: string,
  request: ScheduleEmailRequest,
): Promise<{ batchId: string; jobsCreated: number }> {
  const {
    fromEmail,
    fromName,
    recipients,
    subject,
    body,
    scheduledStartAt,
    delayBetweenEmailsMs = 2000,
    hourlyLimit = 200,
  } = request;

  const scheduledStart = new Date(scheduledStartAt);
  const now = new Date();

  // Create the batch record
  const [batch] = await db
    .insert(emailBatches)
    .values({
      userId,
      subject,
      body,
      fromEmail,
      fromName,
      totalRecipients: recipients.length,
      delayBetweenEmailsMs,
      hourlyLimit,
      scheduledStartAt: scheduledStart,
    })
    .returning();

  // Enqueue each recipient as an individual job
  const jobs = recipients.map((toEmail, index) => {
    const idempotencyKey = uuidv4();
    // Stagger: each job fires delayBetweenEmailsMs after the previous one
    const jobScheduledAt = new Date(
      scheduledStart.getTime() + index * delayBetweenEmailsMs,
    );
    const delayMs = Math.max(0, jobScheduledAt.getTime() - now.getTime());

    return {
      idempotencyKey,
      toEmail: toEmail.trim().toLowerCase(),
      jobScheduledAt,
      delayMs,
    };
  });

  // Insert all jobs to DB in one batch insert
  const jobValues = jobs.map(({ idempotencyKey, toEmail, jobScheduledAt }) => ({
    batchId: batch.id,
    userId,
    idempotencyKey,
    toEmail,
    fromEmail,
    fromName,
    subject,
    body,
    scheduledAt: jobScheduledAt,
    status: 'scheduled' as const,
  }));

  const insertedJobs = await db
    .insert(emailJobs)
    .values(jobValues)
    .returning({ id: emailJobs.id, idempotencyKey: emailJobs.idempotencyKey });

  // Build a map of idempotencyKey -> dbId for BullMQ job data
  const idempotencyToDbId = new Map(
    insertedJobs.map((j) => [j.idempotencyKey, j.id]),
  );

  // Enqueue all jobs to BullMQ
  await Promise.all(
    jobs.map(async ({ idempotencyKey, toEmail, jobScheduledAt, delayMs }) => {
      const emailJobId = idempotencyToDbId.get(idempotencyKey)!;

      const bullJobId = await enqueueEmailJob(
        {
          emailJobId,
          idempotencyKey,
          batchId: batch.id,
          userId,
          toEmail,
          fromEmail,
          fromName,
          subject,
          body,
          scheduledAt: jobScheduledAt.toISOString(),
          delayBetweenEmailsMs,
          hourlyLimit,
        },
        delayMs,
      );

      // Store the BullMQ job ID for reference
      await db
        .update(emailJobs)
        .set({ bullJobId })
        .where(eq(emailJobs.id, emailJobId));
    }),
  );

  console.log(`✅ Scheduled ${recipients.length} emails for batch ${batch.id}`);

  return { batchId: batch.id, jobsCreated: recipients.length };
}

// ─── Query Functions ───────────────────────────────────────────────────────────

export async function getScheduledEmails(
  userId: string,
  page = 1,
  pageSize = 20,
): Promise<PaginatedResponse<EmailJobResponse>> {
  const offset = (page - 1) * pageSize;

  const [totalResult, jobs] = await Promise.all([
    db
      .select({ count: count() })
      .from(emailJobs)
      .where(
        and(
          eq(emailJobs.userId, userId),
          sql`${emailJobs.status} IN ('scheduled', 'processing', 'rate_limited')`,
        ),
      ),
    db
      .select()
      .from(emailJobs)
      .where(
        and(
          eq(emailJobs.userId, userId),
          sql`${emailJobs.status} IN ('scheduled', 'processing', 'rate_limited')`,
        ),
      )
      .orderBy(asc(emailJobs.scheduledAt))
      .limit(pageSize)
      .offset(offset),
  ]);

  const total = totalResult[0]?.count ?? 0;

  return {
    data: jobs.map(mapJobToResponse),
    total: Number(total),
    page,
    pageSize,
    totalPages: Math.ceil(Number(total) / pageSize),
  };
}

export async function getSentEmails(
  userId: string,
  page = 1,
  pageSize = 20,
): Promise<PaginatedResponse<EmailJobResponse>> {
  const offset = (page - 1) * pageSize;

  const [totalResult, jobs] = await Promise.all([
    db
      .select({ count: count() })
      .from(emailJobs)
      .where(
        and(
          eq(emailJobs.userId, userId),
          sql`${emailJobs.status} IN ('sent', 'failed', 'cancelled')`,
        ),
      ),
    db
      .select()
      .from(emailJobs)
      .where(
        and(
          eq(emailJobs.userId, userId),
          sql`${emailJobs.status} IN ('sent', 'failed', 'cancelled')`,
        ),
      )
      .orderBy(desc(emailJobs.sentAt))
      .limit(pageSize)
      .offset(offset),
  ]);

  const total = totalResult[0]?.count ?? 0;

  return {
    data: jobs.map(mapJobToResponse),
    total: Number(total),
    page,
    pageSize,
    totalPages: Math.ceil(Number(total) / pageSize),
  };
}

export async function getEmailStats(userId: string): Promise<StatsResponse> {
  const results = await db
    .select({
      status: emailJobs.status,
      count: count(),
    })
    .from(emailJobs)
    .where(eq(emailJobs.userId, userId))
    .groupBy(emailJobs.status);

  const stats: StatsResponse = {
    scheduled: 0,
    sent: 0,
    failed: 0,
    rateLimited: 0,
    total: 0,
  };

  for (const row of results) {
    const c = Number(row.count);
    stats.total += c;
    if (row.status === 'scheduled' || row.status === 'processing') stats.scheduled += c;
    if (row.status === 'sent') stats.sent += c;
    if (row.status === 'failed') stats.failed += c;
    if (row.status === 'rate_limited') stats.rateLimited += c;
  }

  return stats;
}

export async function cancelScheduledEmail(
  userId: string,
  jobId: string,
): Promise<boolean> {
  const { cancelEmailJob } = await import('../queues/emailQueue');

  const job = await db.query.emailJobs.findFirst({
    where: and(eq(emailJobs.id, jobId), eq(emailJobs.userId, userId)),
  });

  if (!job || job.status !== 'scheduled') return false;

  // Try to remove from BullMQ
  await cancelEmailJob(job.idempotencyKey);

  // Update DB status
  await db
    .update(emailJobs)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(emailJobs.id, jobId));

  return true;
}

export async function toggleStarEmail(
  userId: string,
  jobId: string,
): Promise<boolean> {
  const job = await db.query.emailJobs.findFirst({
    where: and(eq(emailJobs.id, jobId), eq(emailJobs.userId, userId)),
  });

  if (!job) return false;

  const newStarred = !job.isStarred;
  await db
    .update(emailJobs)
    .set({ isStarred: newStarred, updatedAt: new Date() })
    .where(eq(emailJobs.id, jobId));

  return newStarred;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapJobToResponse(job: typeof emailJobs.$inferSelect): EmailJobResponse {
  return {
    id: job.id,
    batchId: job.batchId,
    toEmail: job.toEmail,
    fromEmail: job.fromEmail,
    fromName: job.fromName,
    subject: job.subject,
    body: job.body,
    status: job.status as any,
    scheduledAt: job.scheduledAt.toISOString(),
    sentAt: job.sentAt?.toISOString() ?? null,
    failedAt: job.failedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage ?? null,
    etherealPreviewUrl: job.etherealPreviewUrl ?? null,
    isStarred: job.isStarred,
    createdAt: job.createdAt.toISOString(),
  };
}
