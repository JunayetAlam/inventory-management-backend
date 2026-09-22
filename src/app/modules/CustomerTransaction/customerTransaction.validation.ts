import { z } from 'zod';
import { CustomerTransactionType } from '../../../generated/prisma/client';

const getCustomerTransactionsQuerySchema = z.object({
  body: z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    customerId: z.string().uuid().optional(),
    type: z.nativeEnum(CustomerTransactionType).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    searchTerm: z.string().optional(),
  }),
});

export const customerTransactionValidation = {
  getCustomerTransactionsQuerySchema,
};
