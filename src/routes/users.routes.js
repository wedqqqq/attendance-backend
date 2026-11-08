'use strict';

const { Router } = require('express');
const { body, param } = require('express-validator');
const ctrl = require('../controllers/users.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { handleValidation } = require('../middleware/index');

const router = Router();
router.use(authenticate);

// Admin CRUD
router.get('/',  authorize('admin'), ctrl.listUsers);
router.get('/:id', authorize('admin'), ctrl.getUser);

router.post('/',
  authorize('admin'),
  [
    body('username').notEmpty().trim().isAlphanumeric().withMessage('Alphanumeric only'),
    body('email').isEmail(),
    body('password').isLength({ min: 8 }),
    body('full_name').notEmpty().trim(),
    body('role').isIn(['admin', 'employee']),
  ],
  handleValidation,
  ctrl.createUser
);

router.put('/:id',  authorize('admin'), ctrl.updateUser);
router.delete('/:id', authorize('admin'), ctrl.deleteUser);

// Device management
router.get('/:id/devices', authorize('admin'), ctrl.listDevices);
router.delete('/:id/devices/:deviceId', authorize('admin'), ctrl.revokeDevice);

module.exports = router;
