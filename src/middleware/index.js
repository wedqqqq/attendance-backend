'use strict';

const rateLimit  = require('express-rate-limit');
const { query }  = require('../config/database');
const { error: errorRes } = require('../utils/response');
const logger = require('../config/logger');

// General API rate limiter
const generalLimiter = rateLimit({
  windowMs : parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max      : parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders  : false,
  message : { success: false, message: 'Too many requests, please try again later.' },
});

// Tight limiter for auth endpoints (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max     : 10,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { success: false, message: 'Too many login attempts.' },
});

// Attendance endpoint limiter
const attendanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max     : parseInt(process.env.ATTENDANCE_RATE_LIMIT_MAX || '10', 10),
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders  : false,
  message : { success: false, message: 'Attendance check-in rate limit exceeded.' },
});

// Validation error handler (express-validator)
const { validationResult } = require('express-validator');
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return errorRes(res, 'Validation failed', 400, errors.array());
  }
  next();
}

// Global error handler — must be last in Express chain
function globalErrorHandler(err, req, res, _next) {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  if (res.headersSent) return;
  return errorRes(res, 'Internal server error', 500);
}

/**
 * Write an audit log entry.
 * Fire-and-forget — does not block response.
 */
async function writeAuditLog({ userId, action, entityType, entityId, oldData, newData, req }) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId || null,
        action,
        entityType || null,
        entityId || null,
        oldData ? JSON.stringify(oldData) : null,
        newData ? JSON.stringify(newData) : null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null,
      ]
    );
  } catch (err) {
    logger.error('Audit log write failed', { error: err.message });
  }
}

module.exports = {
  generalLimiter,
  authLimiter,
  attendanceLimiter,
  handleValidation,
  globalErrorHandler,
  writeAuditLog,
};
