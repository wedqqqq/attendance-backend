'use strict';

const { query }  = require('../config/database');
const attendanceService = require('../services/attendance.service');
const { success, error: errRes, paginated } = require('../utils/response');
const { writeAuditLog } = require('../middleware/index');
const logger = require('../config/logger');

// ── Check In ──────────────────────────────────────────────────────────────────
async function checkIn(req, res) {
  const { qr_token, latitude, longitude, gps_accuracy } = req.body;

  try {
    const result = await attendanceService.processCheckIn({
      userId     : req.user.id,
      deviceId   : req.device?.id || null,
      qrToken    : qr_token,
      latitude   : parseFloat(latitude),
      longitude  : parseFloat(longitude),
      gpsAccuracy: gps_accuracy ? parseFloat(gps_accuracy) : null,
    });

    if (!result.success) {
      return errRes(res, result.error, 400, { distanceMeters: result.distanceMeters });
    }

    return success(res, {
      message       : 'Check-in successful',
      attendance    : result.attendance,
      session       : result.session,
      distanceMeters: result.distanceMeters,
    }, 201);
  } catch (err) {
    logger.error('Check-in error', { error: err.message, userId: req.user.id });
    return errRes(res, 'Check-in failed', 500);
  }
}

// ── Check Out ─────────────────────────────────────────────────────────────────
async function checkOut(req, res) {
  const { qr_token, latitude, longitude, gps_accuracy } = req.body;

  try {
    const result = await attendanceService.processCheckOut({
      userId     : req.user.id,
      deviceId   : req.device?.id || null,
      qrToken    : qr_token,
      latitude   : parseFloat(latitude),
      longitude  : parseFloat(longitude),
      gpsAccuracy: gps_accuracy ? parseFloat(gps_accuracy) : null,
    });

    if (!result.success) return errRes(res, result.error, 400);

    return success(res, {
      message     : 'Check-out successful',
      attendance  : result.attendance,
      session     : result.session,
      totalSeconds: result.totalSeconds,
    });
  } catch (err) {
    logger.error('Check-out error', { error: err.message, userId: req.user.id });
    return errRes(res, 'Check-out failed', 500);
  }
}

// ── Report geofence exit (from iOS background task) ───────────────────────────
async function reportGeofenceExit(req, res) {
  const { session_id, branch_id, latitude, longitude, distance_meters } = req.body;

  try {
    const result = await attendanceService.handleGeofenceExit({
      userId        : req.user.id,
      sessionId     : session_id,
      branchId      : branch_id,
      latitude      : parseFloat(latitude),
      longitude     : parseFloat(longitude),
      distanceMeters: parseFloat(distance_meters),
    });
    return success(res, { message: 'Exit recorded', graceExpiresAt: result.graceExpiresAt });
  } catch (err) {
    logger.error('Geofence exit error', { error: err.message });
    return errRes(res, 'Failed to record exit', 500);
  }
}

// ── Report geofence return ────────────────────────────────────────────────────
async function reportGeofenceReturn(req, res) {
  const { session_id, branch_id, latitude, longitude } = req.body;

  try {
    const result = await attendanceService.handleGeofenceReturn({
      userId   : req.user.id,
      sessionId: session_id,
      branchId : branch_id,
      latitude : parseFloat(latitude),
      longitude: parseFloat(longitude),
    });
    return success(res, result);
  } catch (err) {
    logger.error('Geofence return error', { error: err.message });
    return errRes(res, 'Failed to record return', 500);
  }
}

// ── Report violation trigger (from iOS after grace expired) ───────────────────
async function reportViolation(req, res) {
  const { session_id, branch_id } = req.body;

  try {
    const result = await attendanceService.recordViolation({
      userId   : req.user.id,
      sessionId: session_id,
      branchId : branch_id,
    });
    return success(res, { message: 'Violation recorded', violationId: result.violationId });
  } catch (err) {
    logger.error('Violation record error', { error: err.message });
    return errRes(res, 'Failed to record violation', 500);
  }
}

// ── Attendance History (admin + self) ─────────────────────────────────────────
async function getAttendanceHistory(req, res) {
  const { user_id, branch_id, date_from, date_to, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  // Employees can only see their own records
  const targetUserId = req.user.role === 'admin'
    ? (user_id || null)
    : req.user.id;

  const params = [];
  const conditions = [];

  if (targetUserId) { params.push(targetUserId); conditions.push(`a.user_id = $${params.length}`); }
  if (branch_id)    { params.push(branch_id);    conditions.push(`a.branch_id = $${params.length}`); }
  if (date_from)    { params.push(date_from);    conditions.push(`DATE(a.timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') >= $${params.length}`); }
  if (date_to)      { params.push(date_to);      conditions.push(`DATE(a.timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') <= $${params.length}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countRes = await query(`SELECT COUNT(*) FROM attendance a ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT a.*, u.full_name, u.username, b.name AS branch_name
     FROM attendance a
     JOIN users u ON u.id = a.user_id
     JOIN branches b ON b.id = a.branch_id
     ${where}
     ORDER BY a.timestamp DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return paginated(res, rows, total, parseInt(page, 10), parseInt(limit, 10));
}

// ── Work Sessions ─────────────────────────────────────────────────────────────
async function getWorkSessions(req, res) {
  const { user_id, branch_id, date_from, date_to, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const targetUserId = req.user.role === 'admin' ? (user_id || null) : req.user.id;
  const params = [];
  const conditions = [];

  if (targetUserId) { params.push(targetUserId); conditions.push(`ws.user_id = $${params.length}`); }
  if (branch_id)    { params.push(branch_id);    conditions.push(`ws.branch_id = $${params.length}`); }
  if (date_from)    { params.push(date_from);    conditions.push(`ws.session_date >= $${params.length}`); }
  if (date_to)      { params.push(date_to);      conditions.push(`ws.session_date <= $${params.length}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countRes = await query(`SELECT COUNT(*) FROM work_sessions ws ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ws.*, u.full_name, u.username, b.name AS branch_name,
       ROUND(ws.total_seconds::numeric / 3600, 2) AS total_hours
     FROM work_sessions ws
     JOIN users u ON u.id = ws.user_id
     JOIN branches b ON b.id = ws.branch_id
     ${where}
     ORDER BY ws.session_date DESC, ws.started_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return paginated(res, rows, total, parseInt(page, 10), parseInt(limit, 10));
}

module.exports = {
  checkIn, checkOut, reportGeofenceExit, reportGeofenceReturn, reportViolation,
  getAttendanceHistory, getWorkSessions,
};
