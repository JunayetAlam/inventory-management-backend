import { z } from 'zod';
import { DASHBOARD_PRESETS } from './stats.constant';

const isoDateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine(v => {
    const [y, m, d] = v.split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d));
    return (
      utc.getUTCFullYear() === y &&
      utc.getUTCMonth() === m - 1 &&
      utc.getUTCDate() === d
    );
  }, 'Invalid calendar date');

const dashboardQueryFields = z
  .object({
    preset: z.enum(DASHBOARD_PRESETS).default('month'),
    startDate: isoDateOnly.optional(),
    endDate: isoDateOnly.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.preset === 'custom' && (!data.startDate || !data.endDate)) {
      ctx.addIssue({
        code: 'custom',
        message: 'startDate and endDate are required for a custom range',
        path: ['startDate'],
      });
    }
    if (data.startDate && data.endDate && data.startDate > data.endDate) {
      ctx.addIssue({
        code: 'custom',
        message: 'startDate cannot be after endDate',
        path: ['startDate'],
      });
    }
  });

export const parseDashboardQuery = (query: unknown) =>
  dashboardQueryFields.parse(query);

const lowStockQueryFields = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  searchTerm: z.string().trim().optional(),
  sortBy: z.enum(['name', 'stock']).default('stock'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const parseLowStockQuery = (query: unknown) =>
  lowStockQueryFields.parse(query);
