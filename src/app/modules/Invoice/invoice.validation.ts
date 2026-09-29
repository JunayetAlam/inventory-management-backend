import { z } from 'zod';
import { ProductUnit, InvoiceStatus } from '../../../generated/prisma/client';
import { getDuplicateInvoiceProductMessage } from './invoice.utils';

const productUnitEnum = z.nativeEnum(ProductUnit);
const invoiceStatusEnum = z.nativeEnum(InvoiceStatus);

const DUPLICATE_PRODUCT_MESSAGE = getDuplicateInvoiceProductMessage();

const invoiceItemSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  productName: z.string({ error: 'Product name is required' }).min(1, 'Product name cannot be empty'),
  unit: productUnitEnum.default(ProductUnit.PIECE),
  sellingPrice: z.number({ error: 'Selling price is required' }).nonnegative('Selling price cannot be negative'),
  buyingPrice: z.number().nonnegative().optional().nullable(),
  quantity: z.number({ error: 'Quantity is required' }).positive('Quantity must be greater than 0'),
  discounts: z
    .array(z.number().min(0, 'Discount cannot be negative').max(100, 'Discount cannot exceed 100%'))
    .max(4, 'Maximum 4 discounts allowed per product')
    .optional()
    .default([]),
  discount: z.number().min(0, 'Discount cannot be negative').max(100, 'Discount cannot exceed 100%').optional(),
});

const areInvoiceItemsUnique = (
  items: { productId?: string | null; productName?: string }[],
): boolean => {
  const seenProductIds = new Set<string>();
  const seenCustomNames = new Set<string>();

  for (const item of items) {
    if (item.productId) {
      if (seenProductIds.has(item.productId)) return false;
      seenProductIds.add(item.productId);
      continue;
    }

    const key = (item.productName || '').trim().toLowerCase();
    if (!key) continue;
    if (seenCustomNames.has(key)) return false;
    seenCustomNames.add(key);
  }

  return true;
};

const uniqueItemsRefine = {
  message: DUPLICATE_PRODUCT_MESSAGE,
  path: ['items'] as (string | number)[],
};

const createInvoiceSchema = z.object({
  body: z
    .object({
      customerId: z.string().uuid('Invalid customer ID').optional().nullable(),
      countryCode: z.string().regex(/^\+[0-9]{1,4}$/, 'Invalid country code format').optional().nullable(),
      customerPhone: z.string().min(4, 'Phone number must be at least 4 digits').max(20).optional().nullable(),
      customerName: z.string().min(1).max(100).optional().nullable(),
      customerAddress: z.string().max(300).optional().nullable(),
      customerEmail: z.string().email('Invalid email address').optional().nullable().or(z.literal('')),
      items: z.array(invoiceItemSchema).min(1, 'At least one item is required in the invoice'),
      discount: z.number().min(0, 'Overall discount cannot be negative').default(0),
      paidAmount: z.number().min(0, 'Paid amount cannot be negative').default(0),
      note: z.string().max(500, 'Note is too long').optional().nullable(),
    })
    .refine(data => data.customerId || data.customerPhone, {
      message: 'Either customerId or customerPhone is required',
      path: ['customerId'],
    })
    .refine(data => areInvoiceItemsUnique(data.items), uniqueItemsRefine),
});

const updateInvoiceSchema = z.object({
  body: z
    .object({
      customerId: z.string().uuid().optional().nullable(),
      countryCode: z.string().regex(/^\+[0-9]{1,4}$/, 'Invalid country code format').optional().nullable(),
      customerPhone: z.string().min(4).max(20).optional().nullable(),
      customerName: z.string().min(1).max(100).optional().nullable(),
      customerAddress: z.string().max(300).optional().nullable(),
      customerEmail: z.string().email('Invalid email address').optional().nullable().or(z.literal('')),
      status: invoiceStatusEnum.optional(),
      items: z.array(invoiceItemSchema).min(1, 'At least one item is required').optional(),
      discount: z.number().min(0).optional(),
      paidAmount: z.number().min(0).optional(),
      note: z.string().max(500).optional().nullable(),
    })
    .refine(
      data => !data.items || areInvoiceItemsUnique(data.items),
      uniqueItemsRefine,
    ),
});

const addPaymentSchema = z.object({
  body: z.object({
    amount: z.number({ error: 'Payment amount is required' }).positive('Amount must be greater than 0'),
    note: z.string().max(500, 'Note is too long').optional().nullable(),
    date: z.string().optional().nullable(),
  }),
});

const updatePaymentSchema = z.object({
  body: z.object({
    amount: z.number().positive('Amount must be greater than 0').optional(),
    note: z.string().max(500, 'Note is too long').optional().nullable(),
    date: z.string().optional().nullable(),
  }),
});

const deleteRequestSchema = z.object({
  body: z.object({
    reason: z.string().max(300, 'Reason cannot exceed 300 characters').optional(),
  }),
});

const updateStatusSchema = z.object({
  body: z.object({
    status: z.nativeEnum(InvoiceStatus, {
      error: 'Valid invoice status (PENDING, APPROVED, REJECTED) is required',
    }),
  }),
});

export const invoiceValidation = {
  createInvoiceSchema,
  updateInvoiceSchema,
  addPaymentSchema,
  updatePaymentSchema,
  deleteRequestSchema,
  updateStatusSchema,
};
