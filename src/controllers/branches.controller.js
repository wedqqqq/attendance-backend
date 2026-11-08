'use strict';

const { query, withTransaction } = require('../config/database');
const { success, created, notFound, conflict, error: errRes } = require('../utils/response');
const { writeAuditLog } = require('../middleware/index');
const logger = require('../config/logger');

// ── List Branches ─────────────────────────────────────────────────────────────
async function listBranches(req, res) {
  const { is_active } = req.query;
  const params = [];
  const conditions = [];
  if (is_active !== undefined) {
    params.push(is_active === 'true');
    conditions.push(`b.is_active = $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(
    `SELECT b.*,
       COUNT(DISTINCT ea.user_id) FILTER (WHERE ea.is_active = TRUE) AS employee_count
     FROM branches b
     LEFT JOIN employee_assignments ea ON ea.branch_id = b.id
     ${where}
     GROUP BY b.id
     ORDER BY b.created_at DESC`,
    params
  );
  return success(res, rows);
}

// ── Get Branch ────────────────────────────────────────────────────────────────
async function getBranch(req, res) {
  const { rows } = await query(
    `SELECT b.*,
       json_agg(json_build_object('id', u.id, 'full_name', u.full_name, 'username', u.username))
         FILTER (WHERE ea.is_active = TRUE) AS employees
     FROM branches b
     LEFT JOIN employee_assignments ea ON ea.branch_id = b.id AND ea.is_active = TRUE
     LEFT JOIN users u ON u.id = ea.user_id
     WHERE b.id = $1
     GROUP BY b.id`,
    [req.params.id]
  );
  if (rows.length === 0) return notFound(res, 'Branch not found');
  return success(res, rows[0]);
}

// ── Create Branch ─────────────────────────────────────────────────────────────
async function createBranch(req, res) {
  const { name, code, address, latitude, longitude, checkin_radius, active_radius } = req.body;

  const existing = await query('SELECT id FROM branches WHERE code = $1', [code]);
  if (existing.rows.length > 0) return conflict(res, 'Branch code already exists');

  try {
    const { rows } = await query(
      `INSERT INTO branches (name, code, address, latitude, longitude, checkin_radius, active_radius, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name, code, address, latitude, longitude,
       checkin_radius || 50, active_radius || 400, req.user.id]
    );
    writeAuditLog({ userId: req.user.id, action: 'create', entityType: 'branches', entityId: rows[0].id, newData: req.body, req });
    return created(res, rows[0]);
  } catch (err) {
    logger.error('Create branch error', { error: err.message });
    return errRes(res, 'Failed to create branch', 500);
  }
}

// ── Update Branch ─────────────────────────────────────────────────────────────
async function updateBranch(req, res) {
  const { name, address, latitude, longitude, checkin_radius, active_radius, is_active } = req.body;
  const branchId = req.params.id;

  const { rows: existing } = await query('SELECT * FROM branches WHERE id = $1', [branchId]);
  if (existing.length === 0) return notFound(res, 'Branch not found');

  const { rows } = await query(
    `UPDATE branches SET
       name           = COALESCE($1, name),
       address        = COALESCE($2, address),
       latitude       = COALESCE($3, latitude),
       longitude      = COALESCE($4, longitude),
       checkin_radius = COALESCE($5, checkin_radius),
       active_radius  = COALESCE($6, active_radius),
       is_active      = COALESCE($7, is_active)
     WHERE id = $8
     RETURNING *`,
    [name, address, latitude, longitude, checkin_radius, active_radius, is_active, branchId]
  );

  writeAuditLog({ userId: req.user.id, action: 'update', entityType: 'branches', entityId: branchId, oldData: existing[0], newData: req.body, req });
  return success(res, rows[0]);
}

// ── Delete Branch ─────────────────────────────────────────────────────────────
async function deleteBranch(req, res) {
  const branchId = req.params.id;
  const { rows } = await query('SELECT id FROM branches WHERE id = $1', [branchId]);
  if (rows.length === 0) return notFound(res, 'Branch not found');

  await query('UPDATE branches SET is_active = FALSE WHERE id = $1', [branchId]);
  writeAuditLog({ userId: req.user.id, action: 'delete', entityType: 'branches', entityId: branchId, req });
  return success(res, { message: 'Branch deactivated' });
}

// ── Assign Employee ───────────────────────────────────────────────────────────
async function assignEmployee(req, res) {
  const branchId = req.params.id;
  const { user_id, valid_from, valid_until } = req.body;

  const { rows: branch } = await query('SELECT id FROM branches WHERE id = $1 AND is_active = TRUE', [branchId]);
  if (branch.length === 0) return notFound(res, 'Branch not found');

  const { rows: user } = await query('SELECT id FROM users WHERE id = $1 AND role = $2', [user_id, 'employee']);
  if (user.length === 0) return notFound(res, 'Employee not found');

  try {
    const { rows } = await query(
      `INSERT INTO employee_assignments (user_id, branch_id, assigned_by, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, branch_id, valid_from)
       DO UPDATE SET is_active = TRUE, valid_until = EXCLUDED.valid_until
       RETURNING *`,
      [user_id, branchId, req.user.id, valid_from || new Date().toISOString().split('T')[0], valid_until || null]
    );
    writeAuditLog({ userId: req.user.id, action: 'assign', entityType: 'employee_assignments', entityId: rows[0].id, newData: { user_id, branchId }, req });
    return created(res, rows[0]);
  } catch (err) {
    logger.error('Assign employee error', { error: err.message });
    return errRes(res, 'Assignment failed', 500);
  }
}

// ── Unassign Employee ─────────────────────────────────────────────────────────
async function unassignEmployee(req, res) {
  const { id: branchId, userId } = req.params;
  const { rows } = await query(
    `UPDATE employee_assignments SET is_active = FALSE
     WHERE branch_id = $1 AND user_id = $2 AND is_active = TRUE
     RETURNING id`,
    [branchId, userId]
  );
  if (rows.length === 0) return notFound(res, 'Assignment not found');
  writeAuditLog({ userId: req.user.id, action: 'unassign', entityType: 'employee_assignments', entityId: rows[0].id, req });
  return success(res, { message: 'Employee unassigned' });
}

module.exports = {
  listBranches, getBranch, createBranch, updateBranch, deleteBranch,
  assignEmployee, unassignEmployee,
};
