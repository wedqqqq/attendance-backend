'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../config/database');
const { haversineDistance, isValidCoordinates, getLocationStatus } = require('../utils/geo');
const { verifyQRSignature } = require('../utils/qr');
const logger = require('../config/logger');

/**
 * Core check-in flow.
 * Returns { success, attendance, session, error? }
 */
async function processCheckIn({ userId, deviceId, qrToken, latitude, longitude, gpsAccuracy }) {
  if (!isValidCoordinates(latitude, longitude)) {
    return { success: false, error: 'Invalid GPS coordinates' };
  }

  return withTransaction(async (client) => {
    // 1. Validate QR token
    const { rows: qrRows } = await client.query(
      `SELECT dq.*, b.latitude AS branch_lat, b.longitude AS branch_lon,
              b.checkin_radius, b.active_radius, b.id AS branch_id
       FROM daily_qr_codes dq
       JOIN branches b ON b.id = dq.branch_id
       WHERE dq.token = $1 AND dq.status = 'active' AND dq.expires_at > NOW()`,
      [qrToken]
    );

    if (qrRows.length === 0) {
      return { success: false, error: 'QR code is invalid or expired' };
    }

    const qr = qrRows[0];

    // Verify HMAC signature (anti-forgery)
    if (!verifyQRSignature(qrToken, qr.hmac_signature)) {
      return { success: false, error: 'QR signature verification failed' };
    }

    // 2. Verify employee is assigned to this branch
    const { rows: assigned } = await client.query(
      `SELECT id FROM employee_assignments
       WHERE user_id = $1 AND branch_id = $2 AND is_active = TRUE
         AND valid_from <= CURRENT_DATE
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`,
      [userId, qr.branch_id]
    );
    if (assigned.length === 0) {
      return { success: false, error: 'Not assigned to this branch' };
    }

    // 3. GPS distance check
    const distanceMeters = haversineDistance(
      latitude, longitude,
      parseFloat(qr.branch_lat), parseFloat(qr.branch_lon)
    );

    const locationInfo = getLocationStatus(distanceMeters, gpsAccuracy);

    // If GPS accuracy is too poor, record as pending rather than reject
    const attStatus = !locationInfo.accuracyAcceptable
      ? 'pending'
      : locationInfo.withinCheckinZone ? 'valid' : 'invalid';

    if (attStatus === 'invalid') {
      return {
        success: false,
        error: `Too far from branch (${Math.round(distanceMeters)}m, limit: ${qr.checkin_radius}m)`,
        distanceMeters: Math.round(distanceMeters),
      };
    }

    // 4. Check for duplicate active session today
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
    const { rows: activeSession } = await client.query(
      `SELECT id FROM work_sessions
       WHERE user_id = $1 AND branch_id = $2 AND session_date = $3 AND status = 'active'`,
      [userId, qr.branch_id, today]
    );
    if (activeSession.length > 0) {
      return { success: false, error: 'Already checked in with an active session' };
    }

    // 5. Record attendance
    const { rows: att } = await client.query(
      `INSERT INTO attendance
         (user_id, branch_id, device_id, qr_code_id, att_type, att_status,
          latitude, longitude, gps_accuracy, distance_meters)
       VALUES ($1, $2, $3, $4, 'check_in', $5, $6, $7, $8, $9)
       RETURNING *`,
      [userId, qr.branch_id, deviceId, qr.id, attStatus,
       latitude, longitude, gpsAccuracy, distanceMeters]
    );

    // 6. Create work session
    const { rows: session } = await client.query(
      `INSERT INTO work_sessions (user_id, branch_id, check_in_id, session_date, started_at, status)
       VALUES ($1, $2, $3, $4, NOW(), 'active')
       RETURNING *`,
      [userId, qr.branch_id, att[0].id, today]
    );

    return {
      success: true,
      attendance: att[0],
      session: session[0],
      distanceMeters: Math.round(distanceMeters),
    };
  });
}

/**
 * Core check-out flow.
 */
async function processCheckOut({ userId, deviceId, qrToken, latitude, longitude, gpsAccuracy }) {
  if (!isValidCoordinates(latitude, longitude)) {
    return { success: false, error: 'Invalid GPS coordinates' };
  }

  return withTransaction(async (client) => {
    // Validate QR (optional on checkout but enforced for security)
    const { rows: qrRows } = await client.query(
      `SELECT dq.*, b.latitude AS branch_lat, b.longitude AS branch_lon,
              b.checkin_radius, b.id AS branch_id
       FROM daily_qr_codes dq
       JOIN branches b ON b.id = dq.branch_id
       WHERE dq.token = $1 AND dq.status = 'active' AND dq.expires_at > NOW()`,
      [qrToken]
    );
    if (qrRows.length === 0) {
      return { success: false, error: 'QR code is invalid or expired' };
    }

    const qr = qrRows[0];
    if (!verifyQRSignature(qrToken, qr.hmac_signature)) {
      return { success: false, error: 'QR signature verification failed' };
    }

    // Find active session
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
    const { rows: sessions } = await client.query(
      `SELECT id, started_at FROM work_sessions
       WHERE user_id = $1 AND branch_id = $2 AND session_date = $3 AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
      [userId, qr.branch_id, today]
    );
    if (sessions.length === 0) {
      return { success: false, error: 'No active session found for check-out' };
    }

    const distanceMeters = haversineDistance(
      latitude, longitude,
      parseFloat(qr.branch_lat), parseFloat(qr.branch_lon)
    );
    const locationInfo = getLocationStatus(distanceMeters, gpsAccuracy);
    const attStatus = !locationInfo.accuracyAcceptable ? 'pending' : 'valid';

    const { rows: att } = await client.query(
      `INSERT INTO attendance
         (user_id, branch_id, device_id, qr_code_id, att_type, att_status,
          latitude, longitude, gps_accuracy, distance_meters)
       VALUES ($1, $2, $3, $4, 'check_out', $5, $6, $7, $8, $9)
       RETURNING *`,
      [userId, qr.branch_id, deviceId, qr.id, attStatus,
       latitude, longitude, gpsAccuracy, distanceMeters]
    );

    const { rows: session } = await client.query(
      `UPDATE work_sessions
       SET status = 'completed', ended_at = NOW(), check_out_id = $1
       WHERE id = $2
       RETURNING *`,
      [att[0].id, sessions[0].id]
    );

    return {
      success: true,
      attendance: att[0],
      session: session[0],
      totalSeconds: session[0].total_seconds,
    };
  });
}

/**
 * Handle a geofence exit event from iOS.
 * Starts a grace period timer (tracked in geofence_events).
 */
async function handleGeofenceExit({ userId, sessionId, branchId, latitude, longitude, distanceMeters }) {
  const graceMinutes = parseInt(process.env.VIOLATION_GRACE_PERIOD_MINUTES || '5', 10);
  const graceExpires = new Date(Date.now() + graceMinutes * 60 * 1000);

  await query(
    `INSERT INTO geofence_events
       (user_id, session_id, branch_id, event_type, latitude, longitude, distance_meters, grace_expires_at)
     VALUES ($1, $2, $3, 'exit', $4, $5, $6, $7)`,
    [userId, sessionId, branchId, latitude, longitude, distanceMeters, graceExpires]
  );

  logger.info('Geofence exit recorded', { userId, sessionId, distanceMeters, graceExpires });
  return { graceExpiresAt: graceExpires };
}

/**
 * Handle geofence return within grace period — cancel the warning.
 */
async function handleGeofenceReturn({ userId, sessionId, branchId, latitude, longitude }) {
  // Find latest unresolved exit
  const { rows } = await query(
    `SELECT id, grace_expires_at FROM geofence_events
     WHERE user_id = $1 AND session_id = $2 AND event_type = 'exit' AND resolved_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, sessionId]
  );

  if (rows.length === 0) return { withinGrace: false };

  const grace = new Date(rows[0].grace_expires_at);
  const withinGrace = new Date() < grace;

  if (withinGrace) {
    // Cancel the warning
    await query(
      `UPDATE geofence_events SET resolved_at = NOW(), event_type = 'return'
       WHERE id = $1`,
      [rows[0].id]
    );
    await query(
      `INSERT INTO geofence_events (user_id, session_id, branch_id, event_type, latitude, longitude)
       VALUES ($1, $2, $3, 'return', $4, $5)`,
      [userId, sessionId, branchId, latitude, longitude]
    );
    return { withinGrace: true, sessionContinues: true };
  }

  return { withinGrace: false };
}

/**
 * Record a geofence violation — pause the work session.
 */
async function recordViolation({ userId, sessionId, branchId }) {
  return withTransaction(async (client) => {
    // Pause session
    await client.query(
      `UPDATE work_sessions SET status = 'paused', violation_count = violation_count + 1
       WHERE id = $1`,
      [sessionId]
    );

    const { rows } = await client.query(
      `INSERT INTO violations (user_id, session_id, branch_id, violation_type, description)
       VALUES ($1, $2, $3, 'geofence', 'Employee exceeded active zone for more than grace period')
       RETURNING *`,
      [userId, sessionId, branchId]
    );

    return { violationId: rows[0].id };
  });
}

module.exports = {
  processCheckIn,
  processCheckOut,
  handleGeofenceExit,
  handleGeofenceReturn,
  recordViolation,
};
