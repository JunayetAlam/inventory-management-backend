import { z } from 'zod';
import { InvoiceStatus } from '../../../generated/prisma/client';
import { getDuplicateReturnItemMessage } from './returnInvoice.utils';

const invoiceStatusEnum = z.nativeEnum(InvoiceStatus);
const DUPLICATE_ITEM_MESSAGE = getDuplicateReturnItemMessage();

const returnItemSchema = z.object({
  invoiceItemId: z.string().uuid('Invalid invoice item ID'),
  quantity: z.number({ error: 'Quantity is required' }).positive('Quantity must be greater than 0'),
  discounts: z
    .array(z.number().min(0, 'Discount cannot be negative').max(100, 'Discount cannot exceed 100%'))
    .max(4, 'Maximum 4 discounts allowed per product')
    .optional(),
  discount: z
    .number()
    .min(0, 'Discount cannot be negative')
    .max(100, 'Discount cannot exceed 100%')
    .optional(),
});

const areReturnItemsUnique = (items: { invoiceItemId: string }[]): boolean => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.invoiceItemId)) return false;
    seen.add(item.invoiceItemId);
  }
  return true;
};

const uniqueItemsRefine = {
  message: DUPLICATE_ITEM_MESSAGE,
  path: ['items'] as (string | number)[],
};

const createReturnInvoiceSchema = z.object({
  body: z
    .object({
      invoiceId: z.string().uuid('Invalid invoice ID'),
      items: z.array(returnItemSchema).min(1, 'At least one return item is required'),
      discount: z.number().min(0, 'Overall discount cannot be negative').default(0),
      // Optional: when omitted, server defaults refundedAmount to this return's net credit
      refundedAmount: z.number().min(0, 'Refunded amount cannot be negative').optional(),
      note: z.string().max(500, 'Note is too long').optional().nullable(),
    })
    .refine(data => areReturnItemsUnique(data.items), uniqueItemsRefine),
});

const updateReturnInvoiceSchema = z.object({
  body: z
    .object({
      items: z.array(returnItemSchema).min(1, 'At least one return item is required').optional(),
      discount: z.number().min(0).optional(),
      refundedAmount: z.number().min(0).optional(),
      note: z.string().max(500).optional().nullable(),
      status: invoiceStatusEnum.optional(),
    })
    .refine(
      data => !data.items || areReturnItemsUnique(data.items),
      uniqueItemsRefine,
    ),
});

const deleteRequestSchema = z.object({
  body: z.object({
    reason: z.string().max(300, 'Reason cannot exceed 300 characters').optional(),
  }),
});

const updateStatusSchema = z.object({
  body: z.object({
    status: z.nativeEnum(InvoiceStatus, {
      error: 'Valid status (PENDING, APPROVED, REJECTED) is required',
    }),
  }),
});

export const returnInvoiceValidation = {
  createReturnInvoiceSchema,
  updateReturnInvoiceSchema,
  deleteRequestSchema,
  updateStatusSchema,
};
