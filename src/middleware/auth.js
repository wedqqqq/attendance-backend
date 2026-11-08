'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const { query }             = require('../config/database');
const { unauthorized, forbidden } = require('../utils/response');
const logger = require('../config/logger');

/**
 * Verify Bearer JWT. Attaches req.user = { id, role, email, full_name }.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return unauthorized(res, 'Missing access token');
    }

    const token = header.slice(7);
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      return unauthorized(res, 'Invalid or expired access token');
    }

    // Verify user still exists and is active
    const { rows } = await query(
      'SELECT id, role, email, full_name, status FROM users WHERE id = $1',
      [decoded.sub]
    );

    if (rows.length === 0 || rows[0].status !== 'active') {
      return unauthorized(res, 'Account not found or inactive');
    }

    req.user = rows[0];
    next();
  } catch (err) {
    logger.error('Auth middleware error', { error: err.message });
    return unauthorized(res);
  }
}

/**
 * Restrict to one or more roles.
 * Usage: authorize('admin') or authorize('admin', 'employee')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return forbidden(res, 'Insufficient permissions');
    }
    next();
  };
}

/**
 * For employee routes — verify the device_token header matches a registered device.
 * Attaches req.device.
 */
async function verifyDevice(req, res, next) {
  try {
    const deviceToken = req.headers['x-device-token'];
    if (!deviceToken) return unauthorized(res, 'Missing device token');

    const { rows } = await query(
      `SELECT id, user_id, status FROM devices
       WHERE device_token = $1 AND user_id = $2 AND status = 'active'`,
      [deviceToken, req.user.id]
    );

    if (rows.length === 0) {
      return forbidden(res, 'Device not registered or revoked');
    }

    req.device = rows[0];
    next();
  } catch (err) {
    logger.error('Device verify error', { error: err.message });
    return unauthorized(res);
  }
}

module.exports = { authenticate, authorize, verifyDevice };
