import { z } from 'zod';

const toggleMaintenanceSchema = z.object({
  body: z.object({
    isActive: z.boolean({
      error: 'isActive must be a boolean',
    }),
  }),
});

const updateMaintenanceSchema = z.object({
  body: z.object({
    title: z
      .string()
      .trim()
      .min(1, 'Title cannot be empty')
      .max(200, 'Title cannot exceed 200 characters')
      .optional(),
    message: z
      .string()
      .trim()
      .min(1, 'Message cannot be empty')
      .max(2000, 'Message cannot exceed 2000 characters')
      .optional(),
    reason: z
      .string()
      .trim()
      .max(500, 'Reason cannot exceed 500 characters')
      .optional()
      .nullable(),
    estimatedEndTime: z
      .string()
      .datetime({ offset: true, message: 'Invalid estimated end time format' })
      .optional()
      .nullable()
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).optional().nullable())
      .or(z.literal('').transform(() => null)),
    contactEmail: z
      .string()
      .trim()
      .email('Invalid contact email')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
    contactPhone: z
      .string()
      .trim()
      .max(50, 'Contact phone is too long')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
    supportNotice: z
      .string()
      .trim()
      .max(1000, 'Support notice cannot exceed 1000 characters')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
  }),
});

export const maintenanceValidation = {
  toggleMaintenanceSchema,
  updateMaintenanceSchema,
};
