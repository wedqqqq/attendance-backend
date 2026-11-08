'use strict';

const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../config/database');
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require('../utils/jwt');
const { success, unauthorized, error: errRes } = require('../utils/response');
const { writeAuditLog } = require('../middleware/index');
const logger = require('../config/logger');

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(req, res) {
  const { username, password, deviceToken, deviceName, platform, osVersion, appVersion } = req.body;

  try {
    const { rows } = await query(
      `SELECT id, username, email, password_hash, role, full_name, status
       FROM users WHERE username = $1 OR email = $1`,
      [username]
    );

    if (rows.length === 0) return unauthorized(res, 'Invalid credentials');
    const user = rows[0];
    if (user.status !== 'active') return unauthorized(res, 'Account is not active');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return unauthorized(res, 'Invalid credentials');

    // Register or update device if provided
    let deviceId = null;
    if (deviceToken) {
      const dResult = await query(
        `INSERT INTO devices (user_id, device_token, device_name, platform, os_version, app_version, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (device_token)
         DO UPDATE SET last_seen_at = NOW(), status = 'active', device_name = EXCLUDED.device_name
         RETURNING id`,
        [user.id, deviceToken, deviceName || 'Unknown', platform || 'ios', osVersion, appVersion]
      );
      deviceId = dResult.rows[0].id;
    }

    // Tokens
    const payload = { sub: user.id, role: user.role };
    const accessToken  = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);
    const tokenHash    = hashToken(refreshToken);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, tokenHash, deviceId, expiresAt]
    );

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    writeAuditLog({ userId: user.id, action: 'login', req });

    return success(res, {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
      },
    });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    return errRes(res, 'Login failed', 500);
  }
}

// ── Refresh Token ─────────────────────────────────────────────────────────────
async function refreshToken(req, res) {
  const { refreshToken: token } = req.body;
  if (!token) return unauthorized(res, 'Missing refresh token');

  try {
    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch {
      return unauthorized(res, 'Invalid refresh token');
    }

    const tokenHash = hashToken(token);
    const { rows } = await query(
      `SELECT id, user_id, expires_at, revoked FROM refresh_tokens
       WHERE token_hash = $1`,
      [tokenHash]
    );

    if (rows.length === 0 || rows[0].revoked || new Date(rows[0].expires_at) < new Date()) {
      return unauthorized(res, 'Refresh token expired or revoked');
    }

    const { rows: users } = await query(
      'SELECT id, role, status FROM users WHERE id = $1',
      [decoded.sub]
    );
    if (users.length === 0 || users[0].status !== 'active') {
      return unauthorized(res, 'Account inactive');
    }

    const newAccess  = signAccessToken({ sub: users[0].id, role: users[0].role });
    const newRefresh = signRefreshToken({ sub: users[0].id, role: users[0].role });
    const newHash    = hashToken(newRefresh);

    // Rotate refresh token
    await withTransaction(async (client) => {
      await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [rows[0].id]);
      const exp = new Date(); exp.setDate(exp.getDate() + 7);
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [users[0].id, newHash, exp]
      );
    });

    return success(res, { accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    logger.error('Refresh token error', { error: err.message });
    return errRes(res, 'Token refresh failed', 500);
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout(req, res) {
  const { refreshToken: token } = req.body;
  if (token) {
    const hash = hashToken(token);
    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);
  }
  writeAuditLog({ userId: req.user?.id, action: 'logout', req });
  return success(res, { message: 'Logged out successfully' });
}

// ── Change Password ───────────────────────────────────────────────────────────
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  try {
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return errRes(res, 'Current password is incorrect', 400);

    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);

    // Revoke all refresh tokens for security
    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [userId]);

    writeAuditLog({ userId, action: 'password_change', req });
    return success(res, { message: 'Password changed. Please log in again.' });
  } catch (err) {
    logger.error('Change password error', { error: err.message });
    return errRes(res, 'Failed to change password', 500);
  }
}

// ── Me ────────────────────────────────────────────────────────────────────────
async function getMe(req, res) {
  const { rows } = await query(
    'SELECT id, username, email, role, full_name, phone, avatar_url, last_login_at, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  return success(res, rows[0]);
}

module.exports = { login, refreshToken, logout, changePassword, getMe };
