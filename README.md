# ReachInbox — Production Email Job Scheduler & Campaign Dashboard

A **production-grade full-stack email scheduling service and analytics dashboard** built with modern cloud-native architecture. Designed to handle thousands of concurrent scheduled emails with atomic rate limiting, custom domain verification, and zero-data-loss restart survivability.

- **Backend**: Express.js + TypeScript + BullMQ + Upstash Redis + Neon PostgreSQL + Resend REST API (HTTPS) / Ethereal SMTP
- **Frontend**: React + TypeScript + Vite + Tailwind CSS + Lucide Icons + Google OAuth 2.0

---

## 🌟 Key Architectural Features & Newest Highlights

### 1. 🚀 Production Cloud Sending via Resend API (HTTPS Port 443)
Cloud hosting platforms (Render, AWS, DigitalOcean, Heroku, Azure) block standard outbound SMTP ports (25, 465, 587) on free and starter tiers to prevent automated spam networks. 
- **Resend REST API**: To bypass SMTP port restrictions, our email engine supports **Resend HTTP API sending over port 443**, which is never blocked by cloud providers.
- **Custom Domain Support**: Full support for verified custom domain sending (DKIM, SPF, and DMARC verified via name.com, Cloudflare, GoDaddy, etc.).
- **Reply-To Routing**: Emails automatically attach `replyTo: sender@gmail.com`, ensuring that when recipients hit "Reply" in Gmail or Outlook, their messages land directly in the campaign creator's personal inbox!
- **Smart Fallback**: If `RESEND_API_KEY` is not provided, the server gracefully falls back to **Ethereal Email SMTP** for local development and testing.

### 2. 🌩️ Serverless Database & Queue Native (Neon + Upstash)
- **Neon PostgreSQL**: Drizzle ORM configured with automatic SSL/TLS support (`sslmode=require`), allowing seamless connection to serverless PostgreSQL instances.
- **Upstash Redis**: Full support for Upstash serverless Redis (`rediss://` protocol with TLS enabled). The backend automatically parses and configures TLS options when connecting to remote Redis instances.

### 3. 🛡️ BullMQ v5+ Safe Job IDs & Idempotency
- **Underscore Namespace Pattern**: To comply with strict BullMQ v5.7+ validation rules (`Custom Id cannot contain :`), all scheduled jobs use unique IDs formatted as `email_{uuid}`.
- **Atomic Idempotency Checks**: Before any email is dispatched, the worker verifies job status against PostgreSQL to prevent duplicate sending across worker restarts or network retries.

### 4. ⚡ Atomic Rate Limiting & Thundering Herd Protection
- **Per-Sender Hourly Quotas**: Enforced via an **atomic Redis Lua script** (`rate_limit:sender:YYYY-MM-DD-HH`). Safe across multi-worker horizontal scaling.
- **Smart Re-Delaying**: When a sender hits their hourly limit (default: 200 emails/hour), jobs are **never dropped**. Instead, they are automatically rescheduled to fire at the exact start of the next UTC hour!
- **Staggered Dispatch**: When scheduling a batch of 1,000+ emails, delivery is staggered by `MIN_DELAY_BETWEEN_EMAILS_MS` (default: 2,000ms) to prevent overwhelming recipient mail servers.

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js** ≥ 18
- **PostgreSQL** (Local or [Neon.tech](https://neon.tech))
- **Redis** (Local Docker or [Upstash.com](https://upstash.com))
- **Google Cloud Console Project** (for OAuth 2.0 Client ID & Secret)

---

### Step 1: Clone & Configure Environment Variables

```bash
# Backend Setup
cd Email-Job-Schedular-Backend
cp .env.example .env

# Frontend Setup
cd ../Email-Job-Schedular-Fronted
cp .env.example .env
```

#### Backend (`/Email-Job-Schedular-Backend/.env`)
```env
PORT=3001
NODE_ENV=development

# Database (Neon or Local PostgreSQL)
DATABASE_URL=postgresql://user:pass@ep-example.aws.neon.tech/reachbox?sslmode=require

# Redis (Upstash Serverless or Local)
REDIS_URL=rediss://default:token@endpoint.upstash.io:6380

# Google OAuth Credentials
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback

# Frontend URL
FRONTEND_URL=http://localhost:5173

# Worker & Rate Limit Configuration
WORKER_CONCURRENCY=5
MIN_DELAY_BETWEEN_EMAILS_MS=2000
MAX_EMAILS_PER_HOUR_PER_SENDER=200

# Production Sending via Resend (Optional - falls back to Ethereal if empty)
RESEND_API_KEY=re_your_resend_api_key
RESEND_FROM_EMAIL=hello@send.yourdomain.com
```

#### Frontend (`/Email-Job-Schedular-Fronted/.env`)
```env
VITE_API_URL=http://localhost:3001
```

---

### Step 2: Start Infrastructure (If Running Locally)

If you aren't using managed cloud services (Neon/Upstash), start local Redis and PostgreSQL using Docker:
```bash
cd Email-Job-Schedular-Backend
docker-compose up -d
# Launches postgres:5432 and redis:6379
```

---

### Step 3: Install Dependencies & Run Migrations

```bash
# 1. Install Backend Dependencies
cd Email-Job-Schedular-Backend
npm install

# 2. Run PostgreSQL Schema Migrations (Creates users, email_batches, and email_jobs tables)
npm run migrate

# 3. Install Frontend Dependencies
cd ../Email-Job-Schedular-Fronted
npm install
```

---

### Step 4: Launch Development Servers

Open two terminal windows:

**Terminal 1 (Backend API & Worker):**
```bash
cd Email-Job-Schedular-Backend
npm run dev
# Server listening on http://localhost:3001
# Worker concurrency initialized: 5
```

**Terminal 2 (React Dashboard):**
```bash
cd Email-Job-Schedular-Fronted
npm run dev
# Vite UI available on http://localhost:5173
```

---

## 📧 Email Provider Configuration

### Option A: Production Cloud Sending with Resend (Recommended)
1. Sign up at [resend.com](https://resend.com) and generate an API key (`re_...`).
2. Go to **Domains** -> **Add Domain** (e.g., `send.yourdomain.com`).
3. Add the generated DNS records (**MX, SPF, DKIM, and DMARC**) to your domain registrar (Name.com, Cloudflare, GoDaddy).
4. Click **Verify DNS Records** in Resend.
5. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in your `.env`. Your app will now send production-ready emails over secure HTTPS port 443!

### Option B: Local Testing with Ethereal SMTP (Default Fallback)
If `RESEND_API_KEY` is left blank, the server automatically generates a mock Ethereal test account on startup.
- All scheduled emails will be caught by Ethereal without spamming real inboxes.
- The server console prints a clickable preview URL (`https://ethereal.email/message/...`) for every dispatched email!

---

## 🏗 Architecture & Data Flow

### Email Scheduling Lifecycle

```
[React Dashboard] ──POST /api/emails/schedule──► [Express API Handler]
                                                         │
                                                         ├─► 1. INSERT batch into `email_batches`
                                                         ├─► 2. INSERT recipients into `email_jobs` (status = 'scheduled')
                                                         │
                                                         ▼
                                             [Upstash / BullMQ Redis Queue]
                                             jobId = "email_{idempotencyKey}"
                                             score (delay) = scheduledAt - now()
                                                         │
                                                  (At scheduledAt)
                                                         │
                                                         ▼
                                              [BullMQ Background Worker]
                                                         │
                                                         ├─► 1. Idempotency check: verify DB status == 'scheduled'
                                                         ├─► 2. Atomic rate check: Redis Lua counter per sender
                                                         ├─► 3. Enforce spacing: sleep MIN_DELAY_BETWEEN_EMAILS_MS
                                                         ├─► 4. Dispatch: Resend REST API (HTTPS) or Ethereal SMTP
                                                         │
                                                         ▼
                                               [PostgreSQL Database]
                                               UPDATE status ──► 'sent' | 'failed' | 'rate_limited'
```

### Survival Under Restart & Crash Recovery
- **Redis as Source of Truth**: All future scheduled jobs live inside Redis as a Sorted Set (`ZADD`). When the server or background worker restarts, BullMQ reconnects and resumes processing delayed jobs exactly when their timestamp arrives.
- **Zero Duplication Guarantee**: Because job IDs use strict idempotency keys (`email_{uuid}`), even if a network partition causes Redis to re-deliver a job, the worker checks PostgreSQL before sending and aborts if the job is already marked as `sent`.

---

## 📡 REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/google` | Initiate Google OAuth 2.0 login flow |
| `GET` | `/api/auth/me` | Get currently authenticated user profile |
| `POST` | `/api/emails/schedule` | Schedule a new email campaign batch (JSON payload) |
| `POST` | `/api/emails/schedule/csv` | Upload a CSV file to schedule mass recipient campaigns |
| `GET` | `/api/emails/scheduled` | List paginated scheduled emails (`page`, `pageSize`, `search`) |
| `GET` | `/api/emails/sent` | List paginated sent and failed emails with error diagnostics |
| `GET` | `/api/emails/stats` | Retrieve real-time dashboard counts (`scheduled`, `sent`, `failed`) |
| `DELETE` | `/api/emails/:id` | Cancel a scheduled email before delivery |
| `PATCH` | `/api/emails/:id/star` | Toggle starred/favorite status for an email record |
| `GET` | `/health` | Server health check and Redis ping status |

---

## ☁️ Deployment Guide (Render + Vercel)

### Deploying Backend on Render (Free Tier Safe)
1. Connect your GitHub repository to [Render.com](https://render.com) and create a **Web Service**.
2. Set Build Command: `npm install && npm run build`
3. Set Start Command: `npm run start`
4. Add Environment Variables in Render Dashboard:
   - `DATABASE_URL`: Your Neon PostgreSQL URL (`?sslmode=require`)
   - `REDIS_URL`: Your Upstash Redis URL (`rediss://...`)
   - `RESEND_API_KEY`: Your Resend API key
   - `RESEND_FROM_EMAIL`: Your verified sender address (e.g., `hello@send.yourdomain.com`)
   - `FRONTEND_URL`: Your deployed Vercel frontend URL
   - `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`

### Deploying Frontend on Vercel
1. Import your frontend repository on [Vercel.com](https://vercel.com).
2. Set Build Command: `npm run build`
3. Add Environment Variable:
   - `VITE_API_URL`: Your Render backend URL (e.g., `https://reachbox-backend.onrender.com`)
4. In your **Google Cloud Console**, add your Vercel URL to the authorized OAuth Origins and Redirect URIs!

---

## 📝 License
MIT License. Built for scalability, reliability, and modern cloud deployment.