'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

/**
 * Generate a daily QR token and its HMAC signature.
 * Token payload: branchId + date (YYYY-MM-DD) + nonce
 * HMAC prevents forgery; nonce prevents reuse across days.
 */
function generateQRToken(branchId, dateStr) {
  const nonce = uuidv4().replace(/-/g, '');
  const payload = `${branchId}:${dateStr}:${nonce}`;
  const signature = crypto
    .createHmac('sha256', process.env.QR_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
  return { token: payload, hmacSignature: signature, nonce };
}

/**
 * Verify that a scanned QR token matches its stored HMAC.
 */
function verifyQRSignature(token, storedHmac) {
  const expected = crypto
    .createHmac('sha256', process.env.QR_SIGNING_SECRET)
    .update(token)
    .digest('hex');
  // constant-time compare to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(storedHmac, 'hex')
  );
}

/**
 * Render QR code as a base64 PNG data URL.
 */
async function renderQRCodeImage(token) {
  const dataUrl = await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'H',
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  return dataUrl;
}

/**
 * Render QR code as SVG string (for embedding in HTML).
 */
async function renderQRCodeSVG(token) {
  return QRCode.toString(token, { type: 'svg', errorCorrectionLevel: 'H', width: 300 });
}

module.exports = {
  generateQRToken,
  verifyQRSignature,
  renderQRCodeImage,
  renderQRCodeSVG,
};
