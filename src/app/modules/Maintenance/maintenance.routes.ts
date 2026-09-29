import express from 'express';
import requirePrivilegedUser from '../../middlewares/requirePrivilegedUser';
import validateRequest from '../../middlewares/validateRequest';
import { maintenanceValidation } from './maintenance.validation';
import { MaintenanceServices } from './maintenance.service';

const router = express.Router();

// Public endpoint to retrieve maintenance status (allowed during maintenance)
router.get('/public-status', MaintenanceServices.getPublicMaintenanceStatus);

// Privileged operator management endpoints
router.get(
  '/manage',
  requirePrivilegedUser,
  MaintenanceServices.getPrivilegedMaintenanceDetails,
);

router.patch(
  '/toggle',
  requirePrivilegedUser,
  validateRequest.body(maintenanceValidation.toggleMaintenanceSchema),
  MaintenanceServices.toggleMaintenance,
);

router.put(
  '/update',
  requirePrivilegedUser,
  validateRequest.body(maintenanceValidation.updateMaintenanceSchema),
  MaintenanceServices.updateMaintenanceDetails,
);

export const MaintenanceRouters = router;
