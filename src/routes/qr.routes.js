'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/qr.controller');
const { authenticate, authorize } = require('../middleware/auth');

const router = Router();
router.use(authenticate, authorize('admin'));

router.get('/',                      ctrl.listQRCodes);
router.post('/branches/:id/generate', ctrl.generateQR);
router.get('/branches/:id',          ctrl.getQR);
router.delete('/:qrId',              ctrl.revokeQR);
router.get('/:qrId/download',        ctrl.downloadQR);

module.exports = router;
