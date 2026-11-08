'use strict';

const EARTH_RADIUS_METERS = 6371000;

/**
 * Haversine distance between two GPS points (meters).
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Is GPS accuracy acceptable for enforcement decisions?
 * Returns false when accuracy is too poor to conclude a violation.
 */
function isAccuracyAcceptable(accuracyMeters) {
  const threshold = parseInt(process.env.GPS_ACCURACY_THRESHOLD_METERS || '50', 10);
  return accuracyMeters != null && accuracyMeters <= threshold;
}

/**
 * Validate GPS coordinates are within earth bounds.
 */
function isValidCoordinates(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
}

/**
 * Determine location status relative to a branch.
 */
function getLocationStatus(distanceMeters, accuracyMeters) {
  const checkinRadius  = parseInt(process.env.CHECKIN_RADIUS_METERS   || '50',  10);
  const activeRadius   = parseInt(process.env.ACTIVE_ZONE_RADIUS_METERS || '400', 10);

  return {
    distanceMeters,
    withinCheckinZone : distanceMeters <= checkinRadius,
    withinActiveZone  : distanceMeters <= activeRadius,
    accuracyAcceptable: isAccuracyAcceptable(accuracyMeters),
  };
}

/**
 * Current date/time in Vietnam timezone (UTC+7).
 */
function nowVietnam() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
}

/**
 * Returns start (00:00) and end (23:59:59.999) of a Vietnam-local day.
 * @param {Date|string} date - optional; defaults to today
 */
function getVietnamDayBounds(date) {
  const tz = 'Asia/Ho_Chi_Minh';
  const ref = date ? new Date(date) : new Date();
  const local = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  const y = local.getFullYear(), m = local.getMonth(), d = local.getDate();

  // Midnight Vietnam → UTC
  const startLocal = new Date(y, m, d, 0, 0, 0, 0);
  const endLocal   = new Date(y, m, d, 23, 59, 59, 999);
  const offset = 7 * 60; // Vietnam UTC+7
  const startUTC = new Date(startLocal.getTime() - offset * 60 * 1000);
  const endUTC   = new Date(endLocal.getTime()   - offset * 60 * 1000);
  return { startUTC, endUTC };
}

module.exports = {
  haversineDistance,
  isAccuracyAcceptable,
  isValidCoordinates,
  getLocationStatus,
  nowVietnam,
  getVietnamDayBounds,
};
