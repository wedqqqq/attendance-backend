'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/reports.controller');
const { authenticate, authorize } = require('../middleware/auth');

const router = Router();
router.use(authenticate, authorize('admin'));

router.get('/dashboard',      ctrl.getDashboard);
router.get('/working-hours',  ctrl.getWorkingHoursReport);
router.get('/violations',     ctrl.getViolationReport);
router.put('/violations/:id', ctrl.updateViolationStatus);
router.get('/audit-logs',     ctrl.getAuditLogsHandler);
router.get('/export/excel',   ctrl.exportAttendanceExcel);

module.exports = router;
