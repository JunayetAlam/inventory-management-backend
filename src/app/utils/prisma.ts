import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client';
import config from '../../config';

const pool = new Pool({
  connectionString: config.database_url,
  connectionTimeoutMillis: 5000,
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let cachedSuperAdminId: string | null = null;

const resolveSuperAdminId = async (client: any): Promise<string | null> => {
  if (cachedSuperAdminId) return cachedSuperAdminId;
  try {
    const admin = await client.user.findFirst({
      where: { role: 'SUPERADMIN', isDeleted: false },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (admin?.id) {
      cachedSuperAdminId = admin.id;
      return admin.id;
    }
  } catch {
    // Database may not be ready or seeded yet
  }
  return null;
};

const isPrivileged = (val: unknown): boolean =>
  val === 'SYSTEM_PRIVILEGED_ACCESS';

const createPrismaClient = (omitUserSecrets: boolean) => {
  const baseClient = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: config.env === 'development' ? ['error', 'warn'] : ['error'],
    ...(omitUserSecrets
      ? {
          omit: {
            user: {
              password: true,
              otp: true,
              otpExpiry: true,
              otpAttempts: true,
              otpFor: true,
              passwordResetToken: true,
              passwordResetTokenExpires: true,
              emailVerificationToken: true,
              emailVerificationTokenExpires: true,
              isAgreeWithTerms: true,
            },
          },
        }
      : {}),
  });

  return baseClient.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (args) {
            if (operation === 'create') {
              const data = (args as any).data;
              if (data && typeof data === 'object') {
                if (isPrivileged(data.createdById) || isPrivileged(data.updatedById)) {
                  const superAdminId = await resolveSuperAdminId(baseClient);
                  if (isPrivileged(data.createdById)) {
                    data.createdById = superAdminId;
                  }
                  if (isPrivileged(data.updatedById)) {
                    data.updatedById = superAdminId;
                  }
                }
                if (isPrivileged(data.userId)) {
                  data.userId = null;
                }
              }
            } else if (operation === 'createMany') {
              const data = (args as any).data;
              if (data) {
                const superAdminId = await resolveSuperAdminId(baseClient);
                const list = Array.isArray(data) ? data : [data];
                for (const item of list) {
                  if (item && typeof item === 'object') {
                    if (isPrivileged(item.createdById)) item.createdById = superAdminId;
                    if (isPrivileged(item.updatedById)) item.updatedById = superAdminId;
                    if (isPrivileged(item.userId)) item.userId = null;
                  }
                }
              }
            } else if (operation === 'update') {
              const data = (args as any).data;
              if (data && typeof data === 'object') {
                if (isPrivileged(data.updatedById)) {
                  const superAdminId = await resolveSuperAdminId(baseClient);
                  let previousPersonId: string | null = null;
                  try {
                    if (
                      model &&
                      (baseClient as any)[model]?.findUnique &&
                      (args as any).where
                    ) {
                      const existing = await (baseClient as any)[model].findUnique({
                        where: (args as any).where,
                        select: { updatedById: true },
                      });
                      previousPersonId = existing?.updatedById || null;
                    }
                  } catch {
                    // Ignore model field mismatch if table does not have updatedById
                  }

                  // Keep the previous person as editedby if any one already available on the editedby field.
                  // Otherwise, set to superAdminId.
                  data.updatedById = previousPersonId || superAdminId;
                }

                if (isPrivileged(data.createdById)) {
                  const superAdminId = await resolveSuperAdminId(baseClient);
                  data.createdById = superAdminId;
                }

                if (isPrivileged(data.userId)) {
                  data.userId = null;
                }
              }
            } else if (operation === 'updateMany') {
              const data = (args as any).data;
              if (data && typeof data === 'object') {
                if (isPrivileged(data.updatedById)) {
                  const superAdminId = await resolveSuperAdminId(baseClient);
                  data.updatedById = superAdminId;
                }
                if (isPrivileged(data.createdById)) {
                  const superAdminId = await resolveSuperAdminId(baseClient);
                  data.createdById = superAdminId;
                }
                if (isPrivileged(data.userId)) {
                  data.userId = null;
                }
              }
            } else if (operation === 'upsert') {
              const createData = (args as any).create;
              const updateData = (args as any).update;
              const superAdminId = await resolveSuperAdminId(baseClient);

              if (createData && typeof createData === 'object') {
                if (isPrivileged(createData.createdById)) createData.createdById = superAdminId;
                if (isPrivileged(createData.updatedById)) createData.updatedById = superAdminId;
                if (isPrivileged(createData.userId)) createData.userId = null;
              }

              if (updateData && typeof updateData === 'object') {
                if (isPrivileged(updateData.updatedById)) {
                  let previousPersonId: string | null = null;
                  try {
                    if (
                      model &&
                      (baseClient as any)[model]?.findUnique &&
                      (args as any).where
                    ) {
                      const existing = await (baseClient as any)[model].findUnique({
                        where: (args as any).where,
                        select: { updatedById: true },
                      });
                      previousPersonId = existing?.updatedById || null;
                    }
                  } catch {}
                  updateData.updatedById = previousPersonId || superAdminId;
                }
                if (isPrivileged(updateData.createdById)) {
                  updateData.createdById = superAdminId;
                }
                if (isPrivileged(updateData.userId)) {
                  updateData.userId = null;
                }
              }
            }
          }
          return query(args);
        },
      },
    },
  });
};

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
  insecurePrisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient(true);

export const insecurePrisma =
  globalForPrisma.insecurePrisma ?? createPrismaClient(false);

if (config.env !== 'production') {
  globalForPrisma.prisma = prisma;
  globalForPrisma.insecurePrisma = insecurePrisma;
}
