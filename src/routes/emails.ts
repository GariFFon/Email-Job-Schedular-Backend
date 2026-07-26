import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  scheduleEmailBatch,
  getScheduledEmails,
  getSentEmails,
  getEmailStats,
  cancelScheduledEmail,
  toggleStarEmail,
} from '../services/schedulerService';

const router = Router();

// Multer for CSV upload (memory storage, max 5MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.mimetype === 'text/plain' ||
      file.originalname.endsWith('.csv') ||
      file.originalname.endsWith('.txt')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV/TXT files are allowed'));
    }
  },
});

// ─── Validation schemas ────────────────────────────────────────────────────────

const scheduleSchema = z.object({
  fromEmail: z.string().email(),
  fromName: z.string().min(1),
  recipients: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  scheduledStartAt: z.string().datetime(),
  delayBetweenEmailsMs: z.number().int().min(0).max(3600000).optional(),
  hourlyLimit: z.number().int().min(1).max(10000).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/emails/schedule
 * Schedule a batch of emails
 */
router.post('/schedule', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const result = await scheduleEmailBatch(req.jwtUser!.userId, parsed.data);

    res.status(201).json({
      message: `Successfully scheduled ${result.jobsCreated} emails`,
      batchId: result.batchId,
      jobsCreated: result.jobsCreated,
    });
  } catch (err) {
    console.error('POST /emails/schedule error:', err);
    res.status(500).json({ error: 'Failed to schedule emails' });
  }
});

/**
 * POST /api/emails/schedule/csv
 * Schedule emails by uploading a CSV file of recipients
 */
router.post(
  '/schedule/csv',
  authMiddleware as any,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const fileContent = req.file.buffer.toString('utf-8');
      const emails = parseEmailsFromCSV(fileContent);

      if (emails.length === 0) {
        res.status(400).json({ error: 'No valid email addresses found in file' });
        return;
      }

      const body = req.body;
      const parsed = scheduleSchema.safeParse({
        ...body,
        recipients: emails,
        delayBetweenEmailsMs: body.delayBetweenEmailsMs ? parseInt(body.delayBetweenEmailsMs) : undefined,
        hourlyLimit: body.hourlyLimit ? parseInt(body.hourlyLimit) : undefined,
      });

      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const result = await scheduleEmailBatch(req.jwtUser!.userId, parsed.data);

      res.status(201).json({
        message: `Successfully scheduled ${result.jobsCreated} emails`,
        batchId: result.batchId,
        jobsCreated: result.jobsCreated,
        recipientsFound: emails.length,
      });
    } catch (err) {
      console.error('POST /emails/schedule/csv error:', err);
      res.status(500).json({ error: 'Failed to schedule emails from CSV' });
    }
  },
);

/**
 * POST /api/emails/parse-csv
 * Parse a CSV file and return the list of emails
 */
router.post(
  '/parse-csv',
  authMiddleware as any,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      const fileContent = req.file.buffer.toString('utf-8');
      const emails = parseEmailsFromCSV(fileContent);
      res.json({ emails, count: emails.length });
    } catch (_err) {
      res.status(500).json({ error: 'Failed to parse CSV' });
    }
  },
);

/**
 * GET /api/emails/scheduled
 */
router.get('/scheduled', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page || '1'));
    const pageSize = parseInt(String(req.query.pageSize || '20'));
    const result = await getScheduledEmails(req.jwtUser!.userId, page, pageSize);
    res.json(result);
  } catch (err) {
    console.error('GET /emails/scheduled error:', err);
    res.status(500).json({ error: 'Failed to fetch scheduled emails' });
  }
});

/**
 * GET /api/emails/sent
 */
router.get('/sent', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page || '1'));
    const pageSize = parseInt(String(req.query.pageSize || '20'));
    const result = await getSentEmails(req.jwtUser!.userId, page, pageSize);
    res.json(result);
  } catch (err) {
    console.error('GET /emails/sent error:', err);
    res.status(500).json({ error: 'Failed to fetch sent emails' });
  }
});

/**
 * GET /api/emails/stats
 */
router.get('/stats', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const stats = await getEmailStats(req.jwtUser!.userId);
    res.json(stats);
  } catch (err) {
    console.error('GET /emails/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * DELETE /api/emails/:id
 */
router.delete('/:id', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const success = await cancelScheduledEmail(req.jwtUser!.userId, req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Email not found or already sent' });
      return;
    }
    res.json({ message: 'Email cancelled successfully' });
  } catch (err) {
    console.error('DELETE /emails/:id error:', err);
    res.status(500).json({ error: 'Failed to cancel email' });
  }
});

/**
 * PATCH /api/emails/:id/star
 */
router.patch('/:id/star', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const isStarred = await toggleStarEmail(req.jwtUser!.userId, req.params.id);
    res.json({ isStarred });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to update star' });
  }
});

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseEmailsFromCSV(content: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = content.match(emailRegex) || [];
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const email of matches) {
    const normalized = email.toLowerCase().trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      emails.push(normalized);
    }
  }
  return emails;
}

export default router;
