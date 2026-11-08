'use strict';

const ExcelJS = require('exceljs');
const { query } = require('../config/database');
const { success, error: errRes } = require('../utils/response');
const { writeAuditLog } = require('../middleware/index');
const logger = require('../config/logger');

// ── Dashboard Summary ─────────────────────────────────────────────────────────
async function getDashboard(req, res) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });

  const [employees, branches, checkedIn, violations] = await Promise.all([
    query(`SELECT COUNT(*) FROM users WHERE role = 'employee' AND status = 'active'`),
    query(`SELECT COUNT(*) FROM branches WHERE is_active = TRUE`),
    query(
      `SELECT COUNT(*) FROM work_sessions
       WHERE session_date = $1 AND status = 'active'`,
      [today]
    ),
    query(
      `SELECT COUNT(*) FROM violations
       WHERE violation_status = 'open'`
    ),
  ]);

  const { rows: recentAtt } = await query(
    `SELECT a.att_type, a.att_status, a.timestamp,
       u.full_name, b.name AS branch_name
     FROM attendance a
     JOIN users u ON u.id = a.user_id
     JOIN branches b ON b.id = a.branch_id
     WHERE DATE(a.timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') = $1
     ORDER BY a.timestamp DESC LIMIT 10`,
    [today]
  );

  return success(res, {
    totalEmployees   : parseInt(employees.rows[0].count, 10),
    totalBranches    : parseInt(branches.rows[0].count, 10),
    checkedInToday   : parseInt(checkedIn.rows[0].count, 10),
    openViolations   : parseInt(violations.rows[0].count, 10),
    recentAttendance : recentAtt,
  });
}

// ── Working Hours Report ──────────────────────────────────────────────────────
async function getWorkingHoursReport(req, res) {
  const { date_from, date_to, user_id, branch_id } = req.query;

  if (!date_from || !date_to) return errRes(res, 'date_from and date_to are required', 400);

  const params = [date_from, date_to];
  const conditions = [`ws.session_date BETWEEN $1 AND $2`];

  if (user_id)   { params.push(user_id);   conditions.push(`ws.user_id = $${params.length}`); }
  if (branch_id) { params.push(branch_id); conditions.push(`ws.branch_id = $${params.length}`); }

  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(
    `SELECT
       u.id AS user_id, u.full_name, u.username,
       ws.session_date,
       b.name AS branch_name,
       COUNT(*) FILTER (WHERE ws.status = 'completed') AS completed_sessions,
       SUM(ws.total_seconds) FILTER (WHERE ws.status = 'completed') AS total_seconds,
       ROUND(SUM(ws.total_seconds) FILTER (WHERE ws.status = 'completed')::numeric / 3600, 2) AS total_hours,
       SUM(ws.violation_count) AS violation_count
     FROM work_sessions ws
     JOIN users u ON u.id = ws.user_id
     JOIN branches b ON b.id = ws.branch_id
     ${where}
     GROUP BY u.id, u.full_name, u.username, ws.session_date, b.name
     ORDER BY ws.session_date, u.full_name`,
    params
  );

  return success(res, rows);
}

// ── Violation Report ──────────────────────────────────────────────────────────
async function getViolationReport(req, res) {
  const { date_from, date_to, user_id, violation_type, violation_status } = req.query;
  const params = [];
  const conditions = [];

  if (date_from)       { params.push(date_from);       conditions.push(`v.occurred_at >= $${params.length}`); }
  if (date_to)         { params.push(date_to);         conditions.push(`v.occurred_at <= $${params.length}`); }
  if (user_id)         { params.push(user_id);         conditions.push(`v.user_id = $${params.length}`); }
  if (violation_type)  { params.push(violation_type);  conditions.push(`v.violation_type = $${params.length}`); }
  if (violation_status){ params.push(violation_status); conditions.push(`v.violation_status = $${params.length}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(
    `SELECT v.*, u.full_name, u.username, b.name AS branch_name,
       r.full_name AS resolved_by_name
     FROM violations v
     JOIN users u ON u.id = v.user_id
     LEFT JOIN branches b ON b.id = v.branch_id
     LEFT JOIN users r ON r.id = v.resolved_by
     ${where}
     ORDER BY v.occurred_at DESC`,
    params
  );
  return success(res, rows);
}

// ── Acknowledge / Resolve Violation ──────────────────────────────────────────
async function updateViolationStatus(req, res) {
  const { violation_status, note } = req.body;
  const violationId = req.params.id;

  const { rows } = await query(
    `UPDATE violations SET
       violation_status = $1,
       resolved_at      = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
       resolved_by      = CASE WHEN $1 = 'resolved' THEN $2 ELSE resolved_by END
     WHERE id = $3
     RETURNING *`,
    [violation_status, req.user.id, violationId]
  );

  if (rows.length === 0) return errRes(res, 'Violation not found', 404);
  return success(res, rows[0]);
}

// ── Audit Logs ────────────────────────────────────────────────────────────────
async function getAuditLogs(req, res) {
  const { user_id, action, entity_type, date_from, date_to, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];
  if (user_id)     { params.push(user_id);     conditions.push(`user_id = $${params.length}`); }
  if (action)      { params.push(action);      conditions.push(`action = $${params.length}`); }
  if (entity_type) { params.push(entity_type); conditions.push(`entity_type = $${params.length}`); }
  if (date_from)   { params.push(date_from);   conditions.push(`created_at >= $${params.length}`); }
  if (date_to)     { params.push(date_to);     conditions.push(`created_at <= $${params.length}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countRes = await query(`SELECT COUNT(*) FROM audit_logs ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT al.*, u.full_name, u.username
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     ${where}
     ORDER BY al.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { rows, total, page: parseInt(page, 10), limit: parseInt(limit, 10) };
}

async function getAuditLogsHandler(req, res) {
  try {
    const result = await getAuditLogs(req, res);
    const { paginated } = require('../utils/response');
    return paginated(res, result.rows, result.total, result.page, result.limit);
  } catch (err) {
    logger.error('Audit log fetch error', { error: err.message });
    return errRes(res, 'Failed to fetch audit logs', 500);
  }
}

// ── Export Excel ──────────────────────────────────────────────────────────────
async function exportAttendanceExcel(req, res) {
  const { date_from, date_to, user_id, branch_id } = req.query;
  if (!date_from || !date_to) return errRes(res, 'date_from and date_to required', 400);

  try {
    const params = [date_from, date_to];
    const conditions = [`ws.session_date BETWEEN $1 AND $2`];
    if (user_id)   { params.push(user_id);   conditions.push(`ws.user_id = $${params.length}`); }
    if (branch_id) { params.push(branch_id); conditions.push(`ws.branch_id = $${params.length}`); }

    const { rows } = await query(
      `SELECT
         ws.session_date,
         u.full_name, u.username,
         b.name AS branch_name,
         ws.started_at, ws.ended_at, ws.status,
         ROUND(ws.total_seconds::numeric / 3600, 2) AS total_hours,
         ws.violation_count
       FROM work_sessions ws
       JOIN users u ON u.id = ws.user_id
       JOIN branches b ON b.id = ws.branch_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ws.session_date, u.full_name`,
      params
    );

    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance Report');

    worksheet.columns = [
      { header: 'Date',           key: 'session_date',   width: 14 },
      { header: 'Employee Name',  key: 'full_name',      width: 25 },
      { header: 'Username',       key: 'username',       width: 18 },
      { header: 'Branch',         key: 'branch_name',    width: 20 },
      { header: 'Check In',       key: 'started_at',     width: 22 },
      { header: 'Check Out',      key: 'ended_at',       width: 22 },
      { header: 'Status',         key: 'status',         width: 12 },
      { header: 'Hours Worked',   key: 'total_hours',    width: 14 },
      { header: 'Violations',     key: 'violation_count',width: 12 },
    ];

    // Header style
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };

    rows.forEach(row => worksheet.addRow(row));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${date_from}-${date_to}.xlsx"`);

    writeAuditLog({ userId: req.user.id, action: 'export', entityType: 'attendance', req });
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error('Excel export error', { error: err.message });
    return errRes(res, 'Export failed', 500);
  }
}

module.exports = {
  getDashboard,
  getWorkingHoursReport,
  getViolationReport,
  updateViolationStatus,
  getAuditLogsHandler,
  exportAttendanceExcel,
};
