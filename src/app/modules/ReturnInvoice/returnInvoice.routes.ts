import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { returnInvoiceValidation } from './returnInvoice.validation';
import { ReturnInvoiceServices } from './returnInvoice.service';

const router = express.Router();

router.get('/', auth('ANY'), ReturnInvoiceServices.getAllReturnInvoices);

router.get(
  '/returnable/:invoiceId',
  auth('ANY'),
  ReturnInvoiceServices.getReturnableItemsByInvoice,
);

router.get('/:id', auth('ANY'), ReturnInvoiceServices.getReturnInvoiceById);

router.post(
  '/',
  auth('ANY'),
  validateRequest.body(returnInvoiceValidation.createReturnInvoiceSchema),
  ReturnInvoiceServices.createReturnInvoice,
);

router.put(
  '/:id',
  auth('ANY'),
  validateRequest.body(returnInvoiceValidation.updateReturnInvoiceSchema),
  ReturnInvoiceServices.updateReturnInvoice,
);

router.patch(
  '/:id/status',
  auth('SUPERADMIN', 'ADMIN'),
  validateRequest.body(returnInvoiceValidation.updateStatusSchema),
  ReturnInvoiceServices.updateReturnInvoiceStatus,
);

router.delete(
  '/:id',
  auth('ANY'),
  validateRequest.body(returnInvoiceValidation.deleteRequestSchema),
  ReturnInvoiceServices.deleteReturnInvoice,
);

router.patch(
  '/:id/confirm-delete',
  auth('SUPERADMIN', 'ADMIN'),
  ReturnInvoiceServices.confirmDeleteReturnInvoice,
);

router.patch(
  '/:id/reject-delete',
  auth('SUPERADMIN', 'ADMIN'),
  ReturnInvoiceServices.rejectDeleteReturnInvoice,
);

router.patch(
  '/:id/restore',
  auth('SUPERADMIN', 'ADMIN'),
  ReturnInvoiceServices.restoreReturnInvoice,
);

export const ReturnInvoiceRouters = router;
