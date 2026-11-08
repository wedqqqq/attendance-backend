'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { authLimiter, handleValidation } = require('../middleware/index');

const router = Router();

router.post('/login',
  authLimiter,
  [
    body('username').notEmpty().trim(),
    body('password').isLength({ min: 6 }),
  ],
  handleValidation,
  ctrl.login
);

router.post('/refresh',
  [body('refreshToken').notEmpty()],
  handleValidation,
  ctrl.refreshToken
);

router.post('/logout', authenticate, ctrl.logout);

router.get('/me', authenticate, ctrl.getMe);

router.put('/change-password',
  authenticate,
  [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
  ],
  handleValidation,
  ctrl.changePassword
);

module.exports = router;
