'use strict';

const { Router } = require('express');
const router = Router();

router.use('/auth',       require('./auth.routes'));
router.use('/users',      require('./users.routes'));
router.use('/branches',   require('./branches.routes'));
router.use('/qr',         require('./qr.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/locations',  require('./location.routes'));
router.use('/reports',    require('./reports.routes'));

module.exports = router;
