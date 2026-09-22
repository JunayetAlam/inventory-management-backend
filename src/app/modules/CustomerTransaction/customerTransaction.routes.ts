import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { customerTransactionValidation } from './customerTransaction.validation';
import { CustomerTransactionServices } from './customerTransaction.service';

const router = express.Router();

// Get all customer transactions (Admin, Superadmin, Cashier)
router.get(
  '/',
  auth('ANY'),
  validateRequest.query(customerTransactionValidation.getCustomerTransactionsQuerySchema),
  CustomerTransactionServices.getAllCustomerTransactions,
);

// Get transaction stats (Total Transactions, Total Due, Total Payment)
router.get(
  '/stats',
  auth('ANY'),
  validateRequest.query(customerTransactionValidation.getCustomerTransactionsQuerySchema),
  CustomerTransactionServices.getCustomerTransactionStats,
);

// Trigger sync / backfill for existing historical records
router.post(
  '/sync',
  auth('SUPERADMIN', 'ADMIN'),
  CustomerTransactionServices.triggerSyncTransactions,
);

export const CustomerTransactionRouters = router;
