import express from 'express';
import cors from 'cors';
import passport from 'passport';
import { env } from './config/env';
import { testDatabaseConnection } from './config/database';
import { getRedisClient } from './config/redis';
import { initEmailTransporter } from './services/emailService';
import { startEmailWorker } from './queues/emailWorker';
import authRoutes from './routes/auth';
import emailRoutes from './routes/emails';

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(passport.initialize());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/emails', emailRoutes);

// Health check
app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  },
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
  console.log('🚀 Starting ReachInbox Email Scheduler...');

  try {
    // 1. Test DB connection
    await testDatabaseConnection();

    // 2. Connect to Redis
    const redis = getRedisClient();
    await redis.ping();
    console.log('✅ Redis ping OK');

    // 3. Initialize Ethereal SMTP
    await initEmailTransporter();

    // 4. Start BullMQ worker
    startEmailWorker();

    // 5. Start Express server
    app.listen(env.PORT, () => {
      console.log(`\n✅ Server running on http://localhost:${env.PORT}`);
      console.log(`   Environment: ${env.NODE_ENV}`);
      console.log(`   Worker concurrency: ${env.WORKER_CONCURRENCY}`);
      console.log(`   Min delay between emails: ${env.MIN_DELAY_BETWEEN_EMAILS_MS}ms`);
      console.log(`   Max emails/hour/sender: ${env.MAX_EMAILS_PER_HOUR_PER_SENDER}`);
      console.log(`\n📡 API endpoints:`);
      console.log(`   POST /api/auth/google`);
      console.log(`   GET  /api/auth/me`);
      console.log(`   POST /api/emails/schedule`);
      console.log(`   GET  /api/emails/scheduled`);
      console.log(`   GET  /api/emails/sent`);
      console.log(`   GET  /api/emails/stats`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n🛑 Shutting down gracefully...');
      const { stopEmailWorker } = await import('./queues/emailWorker');
      await stopEmailWorker();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

bootstrap();
