'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/location.controller');
const { authenticate, authorize, verifyDevice } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

// Employee sends location
router.post('/update',      verifyDevice, ctrl.updateLocation);
router.post('/sync-offline', verifyDevice, ctrl.syncOfflineLocations);

// Consent
router.put('/consent', ctrl.updateConsent);

// Admin map view
router.get('/active', authorize('admin'), ctrl.getActiveEmployeeLocations);
router.get('/history/:userId', ctrl.getLocationHistory);

module.exports = router;
