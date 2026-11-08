'use strict';

// Tests run against a real DB if DATABASE_URL is set, otherwise mock the pool.
// Run: npm test

const request = require('supertest');
const bcrypt  = require('bcryptjs');

// ── Mock DB for unit tests ────────────────────────────────────────────────────
jest.mock('../src/config/database', () => {
  const rows = {
    users: [
      {
        id: 'user-001', username: 'admin', email: 'admin@test.com',
        password_hash: bcrypt.hashSync('Admin@123456', 12),
        role: 'admin', full_name: 'Admin User', status: 'active',
      },
      {
        id: 'emp-001', username: 'emp1', email: 'emp1@test.com',
        password_hash: bcrypt.hashSync('Employee@123', 12),
        role: 'employee', full_name: 'Employee One', status: 'active',
      },
    ],
  };

  return {
    query: jest.fn(async (sql, params) => {
      if (sql.includes('SELECT NOW()')) return { rows: [{ now: new Date() }] };
      if (sql.includes('FROM users WHERE')) {
        const user = rows.users.find(u => u.id === params?.[0] || u.username === params?.[0] || u.email === params?.[0]);
        return { rows: user ? [user] : [] };
      }
      if (sql.includes('INSERT INTO refresh_tokens')) return { rows: [] };
      if (sql.includes('UPDATE users SET last_login_at')) return { rows: [] };
      if (sql.includes('INSERT INTO audit_logs')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    }),
    withTransaction: jest.fn(async (cb) => cb({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) })),
    testConnection: jest.fn(async () => true),
    pool: { on: jest.fn(), end: jest.fn() },
  };
});

jest.mock('../src/jobs/qr.job', () => ({ startJobs: jest.fn() }));
jest.mock('../src/services/websocket.service', () => ({
  attachWebSocket: jest.fn(),
  broadcastLocationUpdate: jest.fn(),
  broadcastAttendanceEvent: jest.fn(),
}));

process.env.JWT_SECRET            = 'test-jwt-secret-at-least-64-chars-long-padding-padding-pad';
process.env.REFRESH_TOKEN_SECRET  = 'test-refresh-secret-at-least-64-chars-long-padding-padding';
process.env.QR_SIGNING_SECRET     = 'test-qr-secret';
process.env.NODE_ENV              = 'test';
process.env.ALLOWED_ORIGINS       = 'http://localhost:3001';

const app = require('../src/app');

// ── Auth Tests ────────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/login', () => {
  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('returns 200 with tokens on correct credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'Admin@123456' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.role).toBe('admin');
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ── GPS Utility ───────────────────────────────────────────────────────────────
describe('Geo utilities', () => {
  const { haversineDistance, isValidCoordinates, getLocationStatus } = require('../src/utils/geo');

  it('calculates haversine distance correctly', () => {
    // Hanoi to Ho Chi Minh: ~1740 km
    const dist = haversineDistance(21.0285, 105.8542, 10.8231, 106.6297);
    expect(dist).toBeGreaterThan(1_700_000);
    expect(dist).toBeLessThan(1_800_000);
  });

  it('returns 0 for same point', () => {
    expect(haversineDistance(21.0285, 105.8542, 21.0285, 105.8542)).toBeCloseTo(0, 0);
  });

  it('validates coordinates', () => {
    expect(isValidCoordinates(21.0285, 105.8542)).toBe(true);
    expect(isValidCoordinates(91, 0)).toBe(false);
    expect(isValidCoordinates(0, 181)).toBe(false);
    expect(isValidCoordinates('a', 0)).toBe(false);
  });

  it('marks point inside check-in zone', () => {
    process.env.CHECKIN_RADIUS_METERS   = '50';
    process.env.ACTIVE_ZONE_RADIUS_METERS = '400';
    const info = getLocationStatus(30, 10);
    expect(info.withinCheckinZone).toBe(true);
    expect(info.withinActiveZone).toBe(true);
    expect(info.accuracyAcceptable).toBe(true);
  });

  it('marks point outside check-in zone but inside active zone', () => {
    const info = getLocationStatus(200, 20);
    expect(info.withinCheckinZone).toBe(false);
    expect(info.withinActiveZone).toBe(true);
  });

  it('marks point outside active zone', () => {
    const info = getLocationStatus(500, 20);
    expect(info.withinActiveZone).toBe(false);
  });

  it('marks accuracy unacceptable when too poor', () => {
    const info = getLocationStatus(30, 100);
    expect(info.accuracyAcceptable).toBe(false);
  });
});

// ── QR Utilities ──────────────────────────────────────────────────────────────
describe('QR utilities', () => {
  const { generateQRToken, verifyQRSignature } = require('../src/utils/qr');

  it('generates verifiable token', () => {
    const { token, hmacSignature } = generateQRToken('branch-001', '2025-01-01');
    expect(verifyQRSignature(token, hmacSignature)).toBe(true);
  });

  it('rejects tampered token', () => {
    const { token, hmacSignature } = generateQRToken('branch-001', '2025-01-01');
    expect(verifyQRSignature(token + 'x', hmacSignature)).toBe(false);
  });

  it('different branches produce different tokens', () => {
    const a = generateQRToken('branch-001', '2025-01-01');
    const b = generateQRToken('branch-002', '2025-01-01');
    expect(a.token).not.toBe(b.token);
    expect(a.hmacSignature).not.toBe(b.hmacSignature);
  });
});
