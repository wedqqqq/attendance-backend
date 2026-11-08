'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/attendance.controller');
const { authenticate, authorize, verifyDevice } = require('../middleware/auth');
const { attendanceLimiter, handleValidation } = require('../middleware/index');

const router = Router();
router.use(authenticate);

// Employee endpoints — require device verification
router.post('/check-in',
  attendanceLimiter,
  verifyDevice,
  [
    body('qr_token').notEmpty(),
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  ctrl.checkIn
);

router.post('/check-out',
  attendanceLimiter,
  verifyDevice,
  [
    body('qr_token').notEmpty(),
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  ctrl.checkOut
);

// Geofence events from iOS background tasks
router.post('/geofence/exit',   verifyDevice, ctrl.reportGeofenceExit);
router.post('/geofence/return', verifyDevice, ctrl.reportGeofenceReturn);
router.post('/geofence/violation', verifyDevice, ctrl.reportViolation);

// History — admin can see all, employees see own
router.get('/history',  ctrl.getAttendanceHistory);
router.get('/sessions', ctrl.getWorkSessions);

module.exports = router;
