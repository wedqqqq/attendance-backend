'use strict';

const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../config/database');
const { success, created, notFound, conflict, paginated, error: errRes } = require('../utils/response');
const { writeAuditLog } = require('../middleware/index');
const logger = require('../config/logger');

// ── List Users ────────────────────────────────────────────────────────────────
async function listUsers(req, res) {
  const { role, status, search, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const params = [];
  const conditions = [];

  if (role)   { params.push(role);   conditions.push(`role = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(full_name ILIKE $${params.length} OR username ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const countRes = await query(`SELECT COUNT(*) FROM users ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT id, username, email, role, full_name, phone, status, last_login_at, created_at
     FROM users ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return paginated(res, rows, total, parseInt(page, 10), parseInt(limit, 10));
}

// ── Get User ──────────────────────────────────────────────────────────────────
async function getUser(req, res) {
  const { rows } = await query(
    `SELECT id, username, email, role, full_name, phone, avatar_url, status, last_login_at, created_at
     FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return notFound(res, 'User not found');
  return success(res, rows[0]);
}

// ── Create User ───────────────────────────────────────────────────────────────
async function createUser(req, res) {
  const { username, email, password, role, full_name, phone } = req.body;

  try {
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    if (existing.rows.length > 0) return conflict(res, 'Username or email already exists');

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO users (username, email, password_hash, role, full_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, role, full_name, phone, status, created_at`,
      [username, email, hash, role || 'employee', full_name, phone || null]
    );

    writeAuditLog({ userId: req.user.id, action: 'create', entityType: 'users', entityId: rows[0].id, newData: { username, email, role }, req });
    return created(res, rows[0]);
  } catch (err) {
    logger.error('Create user error', { error: err.message });
    return errRes(res, 'Failed to create user', 500);
  }
}

// ── Update User ───────────────────────────────────────────────────────────────
async function updateUser(req, res) {
  const { full_name, phone, role, status, avatar_url } = req.body;
  const userId = req.params.id;

  const { rows: existing } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  if (existing.length === 0) return notFound(res, 'User not found');

  const { rows } = await query(
    `UPDATE users SET
       full_name   = COALESCE($1, full_name),
       phone       = COALESCE($2, phone),
       role        = COALESCE($3, role),
       status      = COALESCE($4, status),
       avatar_url  = COALESCE($5, avatar_url)
     WHERE id = $6
     RETURNING id, username, email, role, full_name, phone, status, updated_at`,
    [full_name, phone, role, status, avatar_url, userId]
  );

  writeAuditLog({ userId: req.user.id, action: 'update', entityType: 'users', entityId: userId, oldData: existing[0], newData: req.body, req });
  return success(res, rows[0]);
}

// ── Delete User ───────────────────────────────────────────────────────────────
async function deleteUser(req, res) {
  const userId = req.params.id;
  if (userId === req.user.id) return errRes(res, 'Cannot delete yourself', 400);

  const { rows } = await query('SELECT id FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return notFound(res, 'User not found');

  // Soft delete via status
  await query('UPDATE users SET status = $1 WHERE id = $2', ['inactive', userId]);
  writeAuditLog({ userId: req.user.id, action: 'delete', entityType: 'users', entityId: userId, req });
  return success(res, { message: 'User deactivated' });
}

// ── List Devices ──────────────────────────────────────────────────────────────
async function listDevices(req, res) {
  const userId = req.params.id;
  const { rows } = await query(
    `SELECT id, device_name, platform, os_version, app_version, status, last_seen_at, registered_at
     FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
    [userId]
  );
  return success(res, rows);
}

// ── Revoke Device ─────────────────────────────────────────────────────────────
async function revokeDevice(req, res) {
  const { userId, deviceId } = req.params;
  const { rows } = await query(
    'UPDATE devices SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
    ['revoked', deviceId, userId]
  );
  if (rows.length === 0) return notFound(res, 'Device not found');
  writeAuditLog({ userId: req.user.id, action: 'update', entityType: 'devices', entityId: deviceId, req });
  return success(res, { message: 'Device revoked' });
}

module.exports = { listUsers, getUser, createUser, updateUser, deleteUser, listDevices, revokeDevice };
