// ─── Shared TypeScript types ───────────────────────────────────────────────────

export type EmailStatus =
  | 'scheduled'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'rate_limited'
  | 'cancelled';

// ─── BullMQ Job Data ──────────────────────────────────────────────────────────
export interface EmailJobData {
  emailJobId: string;
  idempotencyKey: string;
  batchId: string;
  userId: string;
  toEmail: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  scheduledAt: string; // ISO string
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
}

// ─── API Request / Response Types ─────────────────────────────────────────────
export interface ScheduleEmailRequest {
  fromEmail: string;
  fromName: string;
  recipients: string[]; // list of email addresses
  subject: string;
  body: string;
  scheduledStartAt: string; // ISO string
  delayBetweenEmailsMs?: number; // default: 2000
  hourlyLimit?: number; // default: 200
}

export interface EmailJobResponse {
  id: string;
  batchId: string;
  toEmail: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  etherealPreviewUrl: string | null;
  isStarred: boolean;
  createdAt: string;
}

export interface EmailBatchResponse {
  id: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  scheduledStartAt: string;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface StatsResponse {
  scheduled: number;
  sent: number;
  failed: number;
  rateLimited: number;
  total: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

export interface UserSession {
  userId: string;
}
