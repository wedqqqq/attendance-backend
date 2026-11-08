'use strict';

const cron = require('node-cron');
const { query } = require('../config/database');
const { generateQRToken } = require('../utils/qr');
const { getVietnamDayBounds } = require('../utils/geo');
const logger = require('../config/logger');

/**
 * Generate QR codes for all active branches for today (Vietnam time).
 * Runs at 00:01 Vietnam (UTC+7 → 17:01 UTC previous day).
 */
async function generateDailyQRCodes() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
  logger.info('Running daily QR generation', { date: today });

  try {
    const { rows: branches } = await query(
      'SELECT id FROM branches WHERE is_active = TRUE'
    );

    const { endUTC } = getVietnamDayBounds();
    let generated = 0, skipped = 0;

    for (const branch of branches) {
      const existing = await query(
        `SELECT id FROM daily_qr_codes WHERE branch_id = $1 AND qr_date = $2`,
        [branch.id, today]
      );

      if (existing.rows.length > 0) { skipped++; continue; }

      const { token, hmacSignature } = generateQRToken(branch.id, today);
      await query(
        `INSERT INTO daily_qr_codes (branch_id, qr_date, token, hmac_signature, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [branch.id, today, token, hmacSignature, endUTC]
      );
      generated++;
    }

    logger.info('Daily QR generation complete', { generated, skipped });
  } catch (err) {
    logger.error('Daily QR generation failed', { error: err.message });
  }
}

/**
 * Expire QR codes past their expiry timestamp.
 * Runs every 15 minutes.
 */
async function expireOldQRCodes() {
  try {
    const { rowCount } = await query(
      `UPDATE daily_qr_codes SET status = 'expired'
       WHERE status = 'active' AND expires_at < NOW()`
    );
    if (rowCount > 0) logger.info('Expired QR codes', { count: rowCount });
  } catch (err) {
    logger.error('QR expiry sweep failed', { error: err.message });
  }
}

/**
 * Check for unresolved geofence exits past grace period — record violations.
 * Runs every minute.
 */
async function enforceGeofenceViolations() {
  try {
    // Find exit events that passed grace period without being resolved
    const { rows } = await query(
      `SELECT ge.id, ge.user_id, ge.session_id, ge.branch_id
       FROM geofence_events ge
       WHERE ge.event_type = 'exit'
         AND ge.resolved_at IS NULL
         AND ge.grace_expires_at < NOW()`
    );

    for (const ev of rows) {
      // Mark geofence event resolved (as violation)
      await query(
        `UPDATE geofence_events SET resolved_at = NOW(), event_type = 'violation'
         WHERE id = $1`,
        [ev.id]
      );

      // Pause the work session
      await query(
        `UPDATE work_sessions SET status = 'paused', violation_count = violation_count + 1
         WHERE id = $1 AND status = 'active'`,
        [ev.session_id]
      );

      // Create violation record
      await query(
        `INSERT INTO violations (user_id, session_id, branch_id, violation_type, description)
         VALUES ($1, $2, $3, 'geofence', 'Grace period expired — employee outside active zone')
         ON CONFLICT DO NOTHING`,
        [ev.user_id, ev.session_id, ev.branch_id]
      );

      logger.info('Geofence violation recorded by job', { userId: ev.user_id, sessionId: ev.session_id });
    }
  } catch (err) {
    logger.error('Geofence enforcement job failed', { error: err.message });
  }
}

function startJobs() {
  // 00:01 Vietnam time = 17:01 UTC
  cron.schedule('1 17 * * *', generateDailyQRCodes, { timezone: 'UTC' });

  // Every 15 minutes
  cron.schedule('*/15 * * * *', expireOldQRCodes);

  // Every minute — geofence enforcement
  cron.schedule('* * * * *', enforceGeofenceViolations);

  logger.info('Background jobs started');
}

module.exports = { startJobs, generateDailyQRCodes, expireOldQRCodes };
