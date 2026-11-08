'use strict';

const { query } = require('../config/database');
const { isValidCoordinates, haversineDistance } = require('../utils/geo');
const { success, error: errRes, paginated } = require('../utils/response');
const logger = require('../config/logger');

// ── Receive location update from iOS ─────────────────────────────────────────
async function updateLocation(req, res) {
  const { session_id, latitude, longitude, accuracy, client_time, is_offline_sync } = req.body;

  if (!isValidCoordinates(parseFloat(latitude), parseFloat(longitude))) {
    return errRes(res, 'Invalid coordinates', 400);
  }

  // Check consent
  const { rows: consent } = await query(
    'SELECT consented FROM location_consent WHERE user_id = $1',
    [req.user.id]
  );
  if (!consent.length || !consent[0].consented) {
    return errRes(res, 'Location tracking consent not given', 403);
  }

  try {
    // Determine staleness — if client_time is > 10 min old, mark stale
    const clientTs  = client_time ? new Date(client_time) : new Date();
    const ageSecs   = (Date.now() - clientTs.getTime()) / 1000;
    const locStatus = accuracy == null ? 'unknown' : ageSecs > 600 ? 'stale' : 'live';

    await query(
      `INSERT INTO employee_locations
         (user_id, session_id, latitude, longitude, accuracy, loc_status, is_synced, client_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user.id,
        session_id || null,
        parseFloat(latitude),
        parseFloat(longitude),
        accuracy ? parseFloat(accuracy) : null,
        locStatus,
        !is_offline_sync,
        clientTs,
      ]
    );

    return success(res, { message: 'Location recorded', status: locStatus });
  } catch (err) {
    logger.error('Location update error', { error: err.message });
    return errRes(res, 'Failed to record location', 500);
  }
}

// ── Batch sync offline locations ──────────────────────────────────────────────
async function syncOfflineLocations(req, res) {
  const { locations } = req.body; // Array of {session_id, latitude, longitude, accuracy, client_time}

  if (!Array.isArray(locations) || locations.length === 0) {
    return errRes(res, 'No locations provided', 400);
  }

  const { rows: consent } = await query(
    'SELECT consented FROM location_consent WHERE user_id = $1',
    [req.user.id]
  );
  if (!consent.length || !consent[0].consented) {
    return errRes(res, 'Location tracking consent not given', 403);
  }

  let saved = 0;
  for (const loc of locations.slice(0, 100)) { // cap at 100 per batch
    if (!isValidCoordinates(parseFloat(loc.latitude), parseFloat(loc.longitude))) continue;
    try {
      await query(
        `INSERT INTO employee_locations
           (user_id, session_id, latitude, longitude, accuracy, loc_status, is_synced, client_time)
         VALUES ($1, $2, $3, $4, $5, 'stale', FALSE, $6)`,
        [
          req.user.id,
          loc.session_id || null,
          parseFloat(loc.latitude),
          parseFloat(loc.longitude),
          loc.accuracy ? parseFloat(loc.accuracy) : null,
          loc.client_time ? new Date(loc.client_time) : new Date(),
        ]
      );
      saved++;
    } catch (_) { /* skip bad rows */ }
  }

  return success(res, { message: `Synced ${saved} of ${locations.length} locations` });
}

// ── Get latest location per employee (admin map view) ────────────────────────
async function getActiveEmployeeLocations(req, res) {
  // Returns one row per active employee: their most recent location
  const { rows } = await query(
    `SELECT DISTINCT ON (el.user_id)
       el.user_id, el.latitude, el.longitude, el.accuracy, el.loc_status,
       el.client_time, el.server_time,
       u.full_name, u.username,
       ws.id AS session_id, ws.status AS session_status, b.name AS branch_name
     FROM employee_locations el
     JOIN users u ON u.id = el.user_id
     LEFT JOIN work_sessions ws ON ws.id = el.session_id AND ws.status = 'active'
     LEFT JOIN branches b ON b.id = ws.branch_id
     WHERE el.server_time > NOW() - INTERVAL '30 minutes'
     ORDER BY el.user_id, el.server_time DESC`,
    []
  );
  return success(res, rows);
}

// ── Location history for one employee ────────────────────────────────────────
async function getLocationHistory(req, res) {
  const { session_id, date_from, date_to, page = 1, limit = 200 } = req.query;
  const userId = req.params.userId || req.user.id;
  const offset = (page - 1) * limit;

  // Employees can only see their own
  if (req.user.role !== 'admin' && userId !== req.user.id) {
    return errRes(res, 'Forbidden', 403);
  }

  const params = [userId];
  const conditions = ['el.user_id = $1'];

  if (session_id) { params.push(session_id); conditions.push(`el.session_id = $${params.length}`); }
  if (date_from)  { params.push(date_from);  conditions.push(`el.client_time >= $${params.length}`); }
  if (date_to)    { params.push(date_to);    conditions.push(`el.client_time <= $${params.length}`); }

  const where = 'WHERE ' + conditions.join(' AND ');
  const countRes = await query(`SELECT COUNT(*) FROM employee_locations el ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT id, latitude, longitude, accuracy, loc_status, client_time, server_time
     FROM employee_locations el ${where}
     ORDER BY client_time ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return paginated(res, rows, total, parseInt(page, 10), parseInt(limit, 10));
}

// ── Consent management ────────────────────────────────────────────────────────
async function updateConsent(req, res) {
  const { consented } = req.body;
  await query(
    `INSERT INTO location_consent (user_id, consented, consented_at, device_id, ip_address)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       consented = EXCLUDED.consented,
       consented_at = CASE WHEN EXCLUDED.consented THEN NOW() ELSE location_consent.consented_at END,
       revoked_at   = CASE WHEN NOT EXCLUDED.consented THEN NOW() ELSE NULL END,
       updated_at = NOW()`,
    [req.user.id, consented, consented ? new Date() : null, req.device?.id || null, req.ip]
  );
  return success(res, { consented, message: consented ? 'Location tracking enabled' : 'Location tracking disabled' });
}

module.exports = {
  updateLocation, syncOfflineLocations, getActiveEmployeeLocations,
  getLocationHistory, updateConsent,
};
