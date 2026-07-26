# ReachInbox — Email Job Scheduler

A **production-grade email scheduling service + dashboard** built with:
- **Backend**: Express.js + TypeScript + BullMQ + Redis + PostgreSQL + Ethereal SMTP
- **Frontend**: React + TypeScript + Tailwind CSS (Vite)

---

## 🚀 Quick Start

### Prerequisites
- **Docker** (for Redis + PostgreSQL) or local installs
- **Node.js** ≥ 18
- **Google Cloud project** with OAuth 2.0 credentials

---

### 1. Clone & Setup Environment

```bash
# Backend
cd Email-Job-Schedular-Backend
cp .env.example .env
# Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET

# Frontend
cd ../Email-Job-Schedular-Fronted
cp .env.example .env
```

### 2. Start Infrastructure (Docker)

```bash
cd Email-Job-Schedular-Backend
docker-compose up -d
# Starts: postgres:5432, redis:6379
```

**Without Docker** (macOS):
```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
createdb reachbox
```

**Using Cloud Services (Recommended for Zero Setup)**:
Instead of running Docker or Homebrew, you can use managed serverless tiers:
1. **PostgreSQL**: Create a free project at [Neon.tech](https://neon.tech) and paste the connection string into `DATABASE_URL` in `.env`.
2. **Redis**: Create a free Redis database at [Upstash.com](https://upstash.com) and paste the `rediss://` URL (TLS enabled) into `REDIS_URL` in `.env`.
The backend automatically configures SSL/TLS when these connection strings are detected!

### 3. Install Dependencies

```bash
# Backend
cd Email-Job-Schedular-Backend
npm install

# Frontend
cd ../Email-Job-Schedular-Fronted
npm install
```

### 4. Run Database Migrations

```bash
cd Email-Job-Schedular-Backend
npm run migrate
# Creates: users, email_batches, email_jobs tables + indexes
```

### 5. Start Backend

```bash
cd Email-Job-Schedular-Backend
npm run dev
# Server: http://localhost:3001
# Ethereal credentials printed to console on first run
```

### 6. Start Frontend

```bash
cd Email-Job-Schedular-Fronted
npm run dev
# App: http://localhost:5173
```

---

## 📧 Ethereal Email Setup

**Ethereal Email** is a fake SMTP service for testing — emails are captured and viewable at [ethereal.email](https://ethereal.email).

**Auto-setup** (default): If `ETHEREAL_USER` / `ETHEREAL_PASS` are not set in `.env`, the server creates a new test account on startup and prints credentials to the console.

**Manual setup** (reuse account):
1. Go to [ethereal.email](https://ethereal.email) → Create Account
2. Copy the username and password
3. Add to `.env`:
```env
ETHEREAL_USER=your.username@ethereal.email
ETHEREAL_PASS=your_password
```

Every sent email prints a **preview URL** to the server console. Open it to see the rendered email.

---

## 🔑 Google OAuth Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create project → **APIs & Services** → **OAuth 2.0 Client IDs**
3. Application type: **Web application**
4. Authorized redirect URIs: `http://localhost:3001/api/auth/google/callback`
5. Copy `Client ID` and `Client Secret` to backend `.env`

---

## 📋 Environment Variables

### Backend (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Express server port |
| `DATABASE_URL` | — | PostgreSQL connection string (supports Neon SSL) |
| `REDIS_URL` | — | (optional) Redis connection URL (supports Upstash `rediss://`) |
| `REDIS_HOST` | `localhost` | Redis host (fallback if REDIS_URL not set) |
| `REDIS_PORT` | `6379` | Redis port |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | `http://localhost:3001/api/auth/google/callback` | OAuth redirect |
| `FRONTEND_URL` | `http://localhost:5173` | For CORS + OAuth redirect |
| `WORKER_CONCURRENCY` | `5` | BullMQ worker parallelism |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | `2000` | Min delay between sends (ms) |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | Per-sender hourly rate limit |
| `ETHEREAL_USER` | — | (optional) Reuse Ethereal account |
| `ETHEREAL_PASS` | — | (optional) Reuse Ethereal account |

### Frontend (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001` | Backend base URL |

---

## 🏗 Architecture Overview

### How Scheduling Works

```
Client POST /api/emails/schedule
         │
         ▼
  Express Route Handler
         │
         ├─► INSERT email_batches (batch record)
         │
         ├─► INSERT email_jobs[] (one per recipient, status='scheduled')
         │
         └─► enqueueEmailJob() for each recipient
                  │
                  ▼
           BullMQ Queue (Redis Sorted Set)
           jobId = "email:{idempotencyKey}"
           delay = scheduledAt - now
                  │
              (at scheduled time)
                  │
                  ▼
           BullMQ Worker picks up job
                  │
           1. Idempotency check (DB status)
           2. Mark as 'processing'
           3. Redis rate limit check
           4. Minimum delay sleep (2s)
           5. Send via Ethereal SMTP
           6. Update DB to 'sent' or 'failed'
```

### How Persistence on Restart Works

**BullMQ delayed jobs are stored in Redis** as a sorted set (ZADD with score = fire timestamp). When the server restarts:

- The Express server reconnects to Redis and PostgreSQL
- The BullMQ worker reconnects to Redis
- All delayed jobs still exist in Redis and will fire at their scheduled times automatically
- **No re-enqueue logic runs on startup** — the source of truth for scheduling is Redis

**Edge case — Redis data loss**: If Redis is wiped, run the recovery script:
```bash
npm run recover  # Re-enqueues DB 'scheduled' jobs not in Redis
```
(This would not duplicate 'sent' jobs because the worker checks DB status first.)

### How Rate Limiting Works

**Strategy**: Redis atomic counter per `sender:YYYY-MM-DD-HH` key

```lua
-- Lua script (runs atomically on Redis)
local key = "rate_limit:sender@example.com:2024-01-15-14"
local limit = 200
local current = redis.call('GET', key)
if current >= limit then return 0 end  -- Denied
redis.call('INCR', key)               -- Increment
return 1                               -- Allowed
```

- Key has TTL = seconds remaining in current UTC hour + 60s buffer
- Safe across **multiple workers** (atomic Lua script)
- If denied: job is **re-delayed** to `next_hour_start` (not dropped)
- DB status is set to `rate_limited` temporarily, then back to `scheduled`

**BullMQ secondary limiter**:
```typescript
limiter: { max: 5, duration: 2000 }  // Max 5 jobs per 2 seconds
```
This enforces the minimum 2-second delay between sends.

### How Concurrency Works

Worker is configured with `concurrency: 5` (configurable via `WORKER_CONCURRENCY`).
- Up to 5 emails process simultaneously
- Each worker runs its own idempotency + rate limit checks
- Rate limit uses atomic Lua → safe with concurrency

---

## ✅ Features Implemented

### Backend
- [x] Email scheduling via REST API (JSON + CSV upload)
- [x] BullMQ delayed jobs (no cron)
- [x] PostgreSQL persistence (Drizzle ORM)
- [x] Ethereal Email SMTP (auto-creates test account)
- [x] Survival on restart (jobs in Redis sorted set)
- [x] Idempotency (jobId = `email:{uuid}`, DB status check)
- [x] Worker concurrency (configurable, default 5)
- [x] Minimum delay between sends (2s, configurable)
- [x] Per-sender hourly rate limit (Redis Lua, configurable)
- [x] Jobs rescheduled to next hour on rate limit (not dropped)
- [x] Exponential backoff retries (3 attempts: 5s, 10s, 20s)
- [x] Google OAuth (Passport.js)
- [x] Session authentication middleware
- [x] CSV email parsing API
- [x] Paginated email listing (scheduled + sent)
- [x] Email stats (counts by status)
- [x] Cancel scheduled email
- [x] Star/unstar emails
- [x] Docker Compose (Redis + PostgreSQL)

### Frontend
- [x] Google OAuth login (real, not mock)
- [x] Email/password login form (UI only)
- [x] Session persistence in localStorage
- [x] Auto-logout on 401
- [x] Dashboard matching Figma design exactly
- [x] Left sidebar: ONB logo, user profile, Compose button, Scheduled/Sent nav
- [x] Email list: recipient, time badge, subject + preview, star toggle
- [x] Orange clock badge for scheduled emails
- [x] Green "Sent" badge for sent emails
- [x] Compose page: From dropdown, email chip tags, CSV upload, Subject, Delay/Hourly limit, rich text editor
- [x] Email detail view: full header, body, Ethereal preview link
- [x] Loading states (spinners)
- [x] Empty states with CTA
- [x] Toast notifications (react-hot-toast)
- [x] Auto-refresh every 15 seconds
- [x] Star toggle on emails
- [x] TypeScript throughout

---

## 🔄 Behavior Under Load (1000+ emails)

When 1000 emails are scheduled for the same time:

1. All 1000 `email_jobs` are inserted to PostgreSQL atomically
2. All 1000 BullMQ jobs are enqueued with **staggered delays**:
   - Email #1: fires at `scheduledAt`
   - Email #2: fires at `scheduledAt + delayMs`
   - Email #3: fires at `scheduledAt + 2*delayMs`
   - ...
3. This prevents thundering herd (all 1000 hitting the SMTP server at once)
4. With `MAX_EMAILS_PER_HOUR_PER_SENDER=200`:
   - First 200 emails send in hour 1
   - Emails 201–400 are rescheduled to hour 2
   - Emails 401–600 are rescheduled to hour 3
   - etc.

---

## 📡 API Reference

```
POST   /api/auth/google              Initiate Google OAuth
GET    /api/auth/google/callback     OAuth callback
GET    /api/auth/me                  Get current user

POST   /api/emails/schedule          Schedule email batch (JSON)
POST   /api/emails/schedule/csv      Schedule from CSV upload
POST   /api/emails/parse-csv         Parse CSV and return email list
GET    /api/emails/scheduled         List scheduled emails (paginated)
GET    /api/emails/sent              List sent/failed emails (paginated)
GET    /api/emails/stats             Get counts by status
DELETE /api/emails/:id               Cancel a scheduled email
PATCH  /api/emails/:id/star          Toggle star

GET    /health                       Health check
```

---

## ⚖️ Trade-offs & Assumptions

1. **In-process worker**: The BullMQ worker runs in the same process as Express. For production, separate them (`npm run worker` in a separate process/container).

2. **Staggered delays**: Emails within a batch are staggered by `delayBetweenEmailsMs`. This means a 1000-email batch with 2s delay completes in ~33 minutes. For mass sending, reduce the delay.

3. **Rate limit rescheduling**: When rate limit is hit, the current job re-enqueues with a new idempotency key suffix. The original job is not re-used to avoid BullMQ jobId conflicts.

4. **Ethereal SMTP**: Not suitable for production. Replace with SendGrid, AWS SES, or Mailgun by swapping the nodemailer transport.

5. **Email body**: Stored as HTML in PostgreSQL. For very large bodies (10KB+), consider storing in S3 and referencing by URL.

6. **No real-time updates**: Frontend polls every 15 seconds. For production, add WebSocket or Server-Sent Events.