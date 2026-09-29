import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { invoiceValidation } from './invoice.validation';
import { InvoiceServices } from './invoice.service';

const router = express.Router();

// Get all invoices (Admin, Superadmin, Cashier)
router.get('/', auth('ANY'), InvoiceServices.getAllInvoices);

// Get single invoice by ID
router.get('/:id', auth('ANY'), InvoiceServices.getInvoiceById);

// Create invoice with items, pricing, inventory deduction, and initial payment
router.post(
  '/',
  auth('ANY'),
  validateRequest.body(invoiceValidation.createInvoiceSchema),
  InvoiceServices.createInvoice,
);

// Update invoice (Guarded: Cashiers cannot edit APPROVED invoices)
router.put(
  '/:id',
  auth('ANY'),
  validateRequest.body(invoiceValidation.updateInvoiceSchema),
  InvoiceServices.updateInvoice,
);

// Update invoice status (Admin and Superadmin only: Approve / Reject)
router.patch(
  '/:id/status',
  auth('SUPERADMIN', 'ADMIN'),
  validateRequest.body(invoiceValidation.updateStatusSchema),
  InvoiceServices.updateInvoiceStatus,
);

// Delete invoice (Immediate soft delete for Admin; Deletion request for Cashier)
router.delete(
  '/:id',
  auth('ANY'),
  validateRequest.body(invoiceValidation.deleteRequestSchema),
  InvoiceServices.deleteInvoice,
);

// Confirm deletion request (Admin and Superadmin only)
router.patch(
  '/:id/confirm-delete',
  auth('SUPERADMIN', 'ADMIN'),
  InvoiceServices.confirmDeleteInvoice,
);

// Reject deletion request (Admin and Superadmin only)
router.patch(
  '/:id/reject-delete',
  auth('SUPERADMIN', 'ADMIN'),
  InvoiceServices.rejectDeleteInvoice,
);

// Restore / Undo soft-deleted invoice (Admin and Superadmin only)
router.patch(
  '/:id/restore',
  auth('SUPERADMIN', 'ADMIN'),
  InvoiceServices.restoreInvoice,
);

// Add installment or partial payment for remaining due
router.post(
  '/:id/payments',
  auth('ANY'),
  validateRequest.body(invoiceValidation.addPaymentSchema),
  InvoiceServices.addPayment,
);

// Update an existing payment on an invoice
router.patch(
  '/:id/payments/:paymentId',
  auth('ANY'),
  validateRequest.body(invoiceValidation.updatePaymentSchema),
  InvoiceServices.updatePayment,
);

// Approve a payment (Admin/Superadmin only)
router.patch(
  '/:id/payments/:paymentId/approve',
  auth('SUPERADMIN', 'ADMIN'),
  InvoiceServices.approvePayment,
);

// Delete a payment on an invoice (Reverts paid amount)
router.delete(
  '/:id/payments/:paymentId',
  auth('ANY'),
  InvoiceServices.deletePayment,
);

export const InvoiceRouters = router;
