import { z } from 'zod';

const upsertShopSchema = z.object({
  body: z.object({
    name: z
      .string({ error: 'Shop name is required' })
      .trim()
      .min(1, 'Shop name cannot be empty')
      .max(120, 'Shop name is too long'),
    proprietor: z
      .string()
      .trim()
      .max(255, 'Proprietor name is too long')
      .optional()
      .nullable()
      .or(z.literal('')),
    logo: z
      .string()
      .trim()
      .optional()
      .nullable()
      .or(z.literal('')),
    phoneNumbers: z
      .array(
        z.string().trim().min(1, 'Phone number cannot be empty').max(30, 'Phone number is too long')
      )
      .optional()
      .default([]),
    emails: z
      .array(
        z.string().trim().email('Invalid email address')
      )
      .optional()
      .default([]),
    locations: z
      .array(
        z.string().trim().min(1, 'Location cannot be empty').max(300, 'Location is too long')
      )
      .optional()
      .default([]),
  }),
});

export const shopValidation = {
  upsertShopSchema,
};
