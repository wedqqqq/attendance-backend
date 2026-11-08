'use strict';

const { query } = require('../config/database');
const { generateQRToken, renderQRCodeImage, renderQRCodeSVG } = require('../utils/qr');
const { getVietnamDayBounds } = require('../utils/geo');
const { success, created, notFound, error: errRes } = require('../utils/response');
const { writeAuditLog } = require('../middleware/index');
const logger = require('../config/logger');

/**
 * Returns today's date string in Vietnam timezone: YYYY-MM-DD
 */
function todayVietnam() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// ── Generate QR for a branch (idempotent — one per branch per day) ─────────────
async function generateQR(req, res) {
  const branchId = req.params.id;
  const dateStr  = req.query.date || todayVietnam();

  try {
    const { rows: branch } = await query(
      'SELECT id, name FROM branches WHERE id = $1 AND is_active = TRUE',
      [branchId]
    );
    if (branch.length === 0) return notFound(res, 'Branch not found');

    // Check existing
    const { rows: existing } = await query(
      `SELECT id, token, status FROM daily_qr_codes
       WHERE branch_id = $1 AND qr_date = $2 AND status = 'active'`,
      [branchId, dateStr]
    );
    if (existing.length > 0) {
      const image = await renderQRCodeImage(existing[0].token);
      return success(res, { qrCodeId: existing[0].id, token: existing[0].token, image, date: dateStr });
    }

    const { token, hmacSignature } = generateQRToken(branchId, dateStr);
    const { endUTC } = getVietnamDayBounds(dateStr);

    const { rows } = await query(
      `INSERT INTO daily_qr_codes (branch_id, qr_date, token, hmac_signature, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, token, qr_date, expires_at`,
      [branchId, dateStr, token, hmacSignature, endUTC]
    );

    const image = await renderQRCodeImage(token);

    writeAuditLog({ userId: req.user.id, action: 'generate_qr', entityType: 'daily_qr_codes', entityId: rows[0].id, newData: { branchId, dateStr }, req });
    return created(res, { qrCodeId: rows[0].id, token: rows[0].token, image, date: dateStr, expiresAt: rows[0].expires_at });
  } catch (err) {
    logger.error('Generate QR error', { error: err.message });
    return errRes(res, 'Failed to generate QR', 500);
  }
}

// ── Get QR for a branch (today or specified date) ──────────────────────────────
async function getQR(req, res) {
  const branchId = req.params.id;
  const dateStr  = req.query.date || todayVietnam();

  const { rows } = await query(
    `SELECT dq.*, b.name AS branch_name
     FROM daily_qr_codes dq
     JOIN branches b ON b.id = dq.branch_id
     WHERE dq.branch_id = $1 AND dq.qr_date = $2`,
    [branchId, dateStr]
  );
  if (rows.length === 0) return notFound(res, 'QR not generated for this date');

  const image = await renderQRCodeImage(rows[0].token);
  return success(res, { ...rows[0], image });
}

// ── List all QR codes (admin overview) ───────────────────────────────────────
async function listQRCodes(req, res) {
  const { date = todayVietnam(), branch_id } = req.query;
  const params = [date];
  const conditions = ['dq.qr_date = $1'];

  if (branch_id) {
    params.push(branch_id);
    conditions.push(`dq.branch_id = $${params.length}`);
  }

  const { rows } = await query(
    `SELECT dq.id, dq.branch_id, b.name AS branch_name, dq.qr_date, dq.status, dq.generated_at, dq.expires_at
     FROM daily_qr_codes dq
     JOIN branches b ON b.id = dq.branch_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY b.name`,
    params
  );
  return success(res, rows);
}

// ── Revoke QR ─────────────────────────────────────────────────────────────────
async function revokeQR(req, res) {
  const { rows } = await query(
    `UPDATE daily_qr_codes
     SET status = 'revoked', revoked_at = NOW(), revoked_by = $1
     WHERE id = $2 AND status = 'active'
     RETURNING id`,
    [req.user.id, req.params.qrId]
  );
  if (rows.length === 0) return notFound(res, 'Active QR not found');
  return success(res, { message: 'QR revoked' });
}

// ── Download QR as PNG (admin prints) ────────────────────────────────────────
async function downloadQR(req, res) {
  const { rows } = await query(
    'SELECT token, qr_date, branch_id FROM daily_qr_codes WHERE id = $1 AND status = $2',
    [req.params.qrId, 'active']
  );
  if (rows.length === 0) return notFound(res, 'QR not found');

  const { rows: branch } = await query('SELECT name FROM branches WHERE id = $1', [rows[0].branch_id]);
  const svg = await renderQRCodeSVG(rows[0].token);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', `attachment; filename="qr-${branch[0]?.name}-${rows[0].qr_date}.svg"`);
  return res.send(svg);
}

module.exports = { generateQR, getQR, listQRCodes, revokeQR, downloadQR };
