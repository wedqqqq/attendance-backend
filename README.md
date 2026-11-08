# Attendance System — Backend API

Node.js + Express + PostgreSQL (Neon). Deployable to Render free tier + Cloudflare Pages admin.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Database | PostgreSQL 14+ (Neon Free) |
| Auth | JWT (access + refresh) + bcrypt |
| Hosting | Render Free |
| Admin site | Cloudflare Pages |
| Real-time | WebSocket (`/ws`) |

---

## Local Setup

### 1. Prerequisites

- Node.js 18+
- A Neon account: https://neon.tech (free, no credit card)
- Git

### 2. Clone and install

```bash
git clone <your-repo-url> attendance-backend
cd attendance-backend
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/attendance?sslmode=require
JWT_SECRET=<run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
REFRESH_TOKEN_SECRET=<run again for a different value>
QR_SIGNING_SECRET=<run again>
ALLOWED_ORIGINS=http://localhost:3001
```

### 4. Run migrations

```bash
npm run migrate
```

This runs all `.sql` files in `migrations/` in order:
- `001_initial_schema.sql` — creates all 15 tables + enums + triggers
- `002_seed.sql` — creates 1 admin + 2 employees + 2 branches

### 5. Start development server

```bash
npm run dev
```

Server starts at http://localhost:3000

Test it:
```bash
curl http://localhost:3000/health
# → {"status":"ok",...}
```

### 6. Test login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@123456"}'
```

---

## Deployment Guide

### Step 1 — Neon (Database)

1. Go to https://neon.tech → Sign Up (free)
2. Create a new project: name it `attendance`
3. Create a database: `attendance`
4. Copy the connection string from the dashboard:
   ```
   postgresql://user:password@ep-xxx.us-east-1.aws.neon.tech/attendance?sslmode=require
   ```
5. Connect to Neon and run migrations via their SQL editor:
   - Open SQL editor → paste contents of `migrations/001_initial_schema.sql` → Run
   - Paste `migrations/002_seed.sql` → Run

### Step 2 — GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# Create a new repo on github.com then:
git remote add origin https://github.com/YOUR_USERNAME/attendance-backend.git
git push -u origin main
```

**Important:** Never commit `.env`. It's already in `.gitignore`.

### Step 3 — Render (API Hosting)

1. Go to https://render.com → Sign Up (free)
2. New → Web Service → Connect GitHub → select `attendance-backend`
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. Environment Variables — add these in the Render dashboard:
   ```
   NODE_ENV=production
   DATABASE_URL=<your Neon connection string>
   JWT_SECRET=<generate: openssl rand -hex 64>
   REFRESH_TOKEN_SECRET=<generate another>
   QR_SIGNING_SECRET=<generate another>
   ALLOWED_ORIGINS=https://your-admin.pages.dev
   TZ=Asia/Ho_Chi_Minh
   CHECKIN_RADIUS_METERS=50
   ACTIVE_ZONE_RADIUS_METERS=400
   VIOLATION_GRACE_PERIOD_MINUTES=5
   GPS_ACCURACY_THRESHOLD_METERS=50
   ```
5. Click **Deploy**
6. Wait 2–3 minutes. Test:
   ```
   curl https://your-service.onrender.com/health
   ```

> **Free tier note:** Render free services sleep after 15 minutes of inactivity. First request after sleep takes ~30 seconds. Acceptable for testing; upgrade to $7/mo Starter for production.

### Step 4 — Cloudflare Pages (Admin Website)

If you have an existing admin website:

1. Push your admin site to GitHub (separate repo or subdirectory)
2. Go to https://pages.cloudflare.com → Create a project → Connect GitHub
3. Build settings depend on your stack (React: `npm run build`, output: `build` or `dist`)
4. Environment variable in Cloudflare Pages build settings:
   ```
   REACT_APP_API_BASE_URL=https://your-service.onrender.com/api/v1
   ```
   (or `VITE_API_BASE_URL` if using Vite)
5. Update Render's `ALLOWED_ORIGINS` to your Pages URL

---

## API Reference

Base URL: `https://your-service.onrender.com/api/v1`

All authenticated endpoints require:
```
Authorization: Bearer <accessToken>
```

Employee mobile endpoints also require:
```
X-Device-Token: <device_token registered at login>
```

---

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | No | Login, get tokens |
| POST | `/auth/refresh` | No | Rotate refresh token |
| POST | `/auth/logout` | Yes | Revoke refresh token |
| GET  | `/auth/me` | Yes | Current user info |
| PUT  | `/auth/change-password` | Yes | Change password |

**Login body:**
```json
{
  "username": "admin",
  "password": "Admin@123456",
  "deviceToken": "unique-device-uuid",
  "deviceName": "iPhone 15",
  "platform": "ios",
  "osVersion": "17.0",
  "appVersion": "1.0.0"
}
```

---

### Users (Admin only)

| Method | Path | Description |
|---|---|---|
| GET    | `/users` | List employees (filter: role, status, search) |
| GET    | `/users/:id` | Get user |
| POST   | `/users` | Create user |
| PUT    | `/users/:id` | Update user |
| DELETE | `/users/:id` | Soft-delete user |
| GET    | `/users/:id/devices` | List devices |
| DELETE | `/users/:id/devices/:deviceId` | Revoke device |

---

### Branches (Admin: write, all: read)

| Method | Path | Description |
|---|---|---|
| GET    | `/branches` | List all branches |
| GET    | `/branches/:id` | Branch detail + assigned employees |
| POST   | `/branches` | Create branch |
| PUT    | `/branches/:id` | Update branch |
| DELETE | `/branches/:id` | Deactivate branch |
| POST   | `/branches/:id/assign` | Assign employee (`{ user_id }`) |
| DELETE | `/branches/:id/assign/:userId` | Unassign employee |

**Create branch body:**
```json
{
  "name": "Quầy A",
  "code": "BRANCH-A",
  "address": "123 ABC Street",
  "latitude": 21.0285,
  "longitude": 105.8542,
  "checkin_radius": 50,
  "active_radius": 400
}
```

---

### QR Codes (Admin only)

| Method | Path | Description |
|---|---|---|
| GET    | `/qr` | List all QR codes (filter: date, branch_id) |
| POST   | `/qr/branches/:id/generate` | Generate/get today's QR for branch |
| GET    | `/qr/branches/:id` | Get QR for branch (query: ?date=YYYY-MM-DD) |
| DELETE | `/qr/:qrId` | Revoke QR |
| GET    | `/qr/:qrId/download` | Download SVG |

Response includes `image` (base64 PNG data URL) for display.

---

### Attendance (Employee + Admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/attendance/check-in` | Employee + Device | Check in |
| POST | `/attendance/check-out` | Employee + Device | Check out |
| POST | `/attendance/geofence/exit` | Employee + Device | Report leaving zone |
| POST | `/attendance/geofence/return` | Employee + Device | Report returning to zone |
| POST | `/attendance/geofence/violation` | Employee + Device | Report grace expired |
| GET  | `/attendance/history` | Both | Attendance records |
| GET  | `/attendance/sessions` | Both | Work sessions |

**Check-in body:**
```json
{
  "qr_token": "<scanned QR token string>",
  "latitude": 21.0285,
  "longitude": 105.8542,
  "gps_accuracy": 15.0
}
```

---

### Locations (Employee writes, Admin reads)

| Method | Path | Description |
|---|---|---|
| POST | `/locations/update` | Send GPS update |
| POST | `/locations/sync-offline` | Batch sync offline locations |
| PUT  | `/locations/consent` | Update tracking consent |
| GET  | `/locations/active` | Admin: latest position per employee |
| GET  | `/locations/history/:userId` | Location trail |

---

### Reports (Admin only)

| Method | Path | Description |
|---|---|---|
| GET | `/reports/dashboard` | Summary stats for today |
| GET | `/reports/working-hours` | Hours worked by employee/date |
| GET | `/reports/violations` | Violation list |
| PUT | `/reports/violations/:id` | Update violation status |
| GET | `/reports/audit-logs` | Admin activity log |
| GET | `/reports/export/excel` | Download Excel report |

---

## WebSocket (Real-time Map)

Connect: `wss://your-service.onrender.com/ws?token=<accessToken>`

Admin-only. Receives:
```json
{ "type": "location_update", "data": { "userId": "...", "latitude": ..., "longitude": ... } }
{ "type": "attendance_event", "data": { ... } }
```

---

## Background Jobs

| Job | Schedule | Action |
|---|---|---|
| Generate daily QR | 00:01 Vietnam time | Auto-create QR for all active branches |
| Expire old QRs | Every 15 minutes | Mark expired QRs |
| Enforce geofence violations | Every minute | Pause sessions + create violations after grace period |

---

## Geofence State Machine

```
Check-in (within 50m)
        ↓
   WORKING (within 400m)
        ↓ exits 400m
   EXIT DETECTED → grace timer starts (5 min)
        ↓                    ↓
   returns within 400m    grace expires
        ↓                    ↓
   WARNING CANCELLED    VIOLATION recorded
                            session PAUSED
                                ↓
                        employee re-enters 50m
                        and re-scans QR
                                ↓
                        NEW work session created
                        time gap NOT counted
```

---

## Database Schema Overview

15 tables:

```
users → refresh_tokens, devices, employee_assignments, location_consent, violations
branches → employee_assignments, daily_qr_codes, attendance, work_sessions, geofence_events
work_sessions → attendance, employee_locations, geofence_events, violations
audit_logs (append-only)
```

---

## Security Notes

- Passwords hashed with bcrypt (cost factor 12)
- JWT access tokens expire in 15 minutes; refresh tokens expire in 7 days
- Refresh tokens are rotated on every use
- QR tokens signed with HMAC-SHA256; verified on every scan
- Rate limiting: 100 req/15min general; 10 req/15min on auth; 10 req/min on attendance
- All secrets via environment variables — never committed to source
- CORS locked to specified origins
- GPS accuracy checked before geofence enforcement decisions

---

## Test Credentials (seed data)

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `Admin@123456` |
| Employee | `nguyen.van.a` | `Employee@123` |
| Employee | `tran.thi.b` | `Employee@123` |

---

## Free Tier Limits

| Service | Limit |
|---|---|
| Render Free | Sleeps after 15 min inactivity; 750 hours/month |
| Neon Free | 0.5 GB storage; 1 compute unit; connection pooling included |
| Cloudflare Pages | Unlimited static hosting |

Do not use the free tier for production traffic without upgrade.
