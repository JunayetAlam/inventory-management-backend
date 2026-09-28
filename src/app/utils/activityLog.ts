import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from './prisma';

export interface CreateActivityLogPayload {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Prisma.InputJsonValue | null;
  req?: Request;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Utility function to record activity logs in a non-blocking (fire-and-forget) manner.
 */
export const logActivity = (payload: CreateActivityLogPayload): void => {
  const ipAddress =
    payload.ipAddress ||
    (payload.req
      ? (payload.req.headers['x-forwarded-for'] as string) ||
        payload.req.socket.remoteAddress ||
        payload.req.ip ||
        null
      : null);

  const userAgent =
    payload.userAgent ||
    (payload.req ? (payload.req.headers['user-agent'] as string) || null : null);

  if (
    payload.req?.isPrivilegedAccess === true ||
    payload.userId === 'SYSTEM_PRIVILEGED_ACCESS'
  ) {
    return;
  }

  const safeUserId = payload.userId || null;

  prisma.activityLog
    .create({
      data: {
        userId: safeUserId,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId || null,
        details:
          payload.details !== undefined && payload.details !== null
            ? (payload.details as Prisma.InputJsonValue)
            : undefined,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 100) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 255) : null,
      },
    })
    .catch(err => {
      console.error('[ActivityLog Service Error]:', err);
    });
};
