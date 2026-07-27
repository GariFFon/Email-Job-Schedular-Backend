import { Queue } from 'bullmq';
import { createBullMQConnection } from '../config/redis';
import type { EmailJobData } from '../types';

export const EMAIL_QUEUE_NAME = 'email-queue';

// Singleton queue instance
let emailQueue: Queue<EmailJobData> | null = null;

export function getEmailQueue(): Queue<EmailJobData> {
  if (!emailQueue) {
    emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
      connection: createBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s
        },
        removeOnComplete: {
          age: 7 * 24 * 60 * 60, // Keep completed jobs for 7 days
          count: 5000,
        },
        removeOnFail: {
          age: 30 * 24 * 60 * 60, // Keep failed jobs for 30 days
        },
      },
    });

    emailQueue.on('error', (err) => {
      console.error('❌ Email queue error:', err.message);
    });
  }

  return emailQueue;
}

/**
 * Enqueue an email job with a specific delay.
 * Uses idempotencyKey as the job ID to prevent duplicate scheduling.
 */
export async function enqueueEmailJob(
  jobData: EmailJobData,
  delayMs: number,
): Promise<string> {
  const queue = getEmailQueue();

  const job = await queue.add(
    'send-email',
    jobData,
    {
      jobId: `email_${jobData.idempotencyKey}`, // Prevents duplicate jobs
      delay: Math.max(0, delayMs),
    },
  );

  return job.id ?? jobData.idempotencyKey;
}

/**
 * Remove a job from the queue (cancel scheduled email).
 */
export async function cancelEmailJob(idempotencyKey: string): Promise<boolean> {
  const queue = getEmailQueue();
  const jobId = `email_${idempotencyKey}`;
  const job = await queue.getJob(jobId);

  if (!job) return false;

  const state = await job.getState();
  if (state === 'delayed' || state === 'waiting') {
    await job.remove();
    return true;
  }

  return false;
}
