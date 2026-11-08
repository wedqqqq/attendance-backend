'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/branches.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { handleValidation } = require('../middleware/index');

const router = Router();
router.use(authenticate);

router.get('/',  ctrl.listBranches);
router.get('/:id', ctrl.getBranch);

router.post('/',
  authorize('admin'),
  [
    body('name').notEmpty().trim(),
    body('code').notEmpty().trim().toUpperCase(),
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
  ],
  handleValidation,
  ctrl.createBranch
);

router.put('/:id',    authorize('admin'), ctrl.updateBranch);
router.delete('/:id', authorize('admin'), ctrl.deleteBranch);

// Assignments
router.post('/:id/assign',
  authorize('admin'),
  [body('user_id').isUUID()],
  handleValidation,
  ctrl.assignEmployee
);
router.delete('/:id/assign/:userId', authorize('admin'), ctrl.unassignEmployee);

module.exports = router;
