import { Request } from 'express';
import {
  NotificationTargetType,
  NotificationType,
} from '../../generated/prisma/client';
import { prisma } from './prisma';

export interface SendNotificationPayload {
  userId?: string | null;
  title: string;
  message: string;
  type?: NotificationType;
  targetType?: NotificationTargetType;
  link?: string | null;
  /** Pass the Express request object to auto-skip for privileged-access sessions. */
  req?: Request;
}

export interface BroadcastNotificationPayload {
  title: string;
  message: string;
  type?: NotificationType;
  link?: string | null;
  /** Pass the Express request object to auto-skip for privileged-access sessions. */
  req?: Request;
}

const isPrivileged = (req: Request | undefined): boolean =>
  req?.isPrivilegedAccess === true;

/**
 * Utility function to send notification to a single specific user in a non-blocking (fire-and-forget) manner.
 * Automatically skips when the request originates from a privileged-access session.
 */
export const sendNotification = (payload: SendNotificationPayload): void => {
  if (isPrivileged(payload.req)) return;

  prisma.notification
    .create({
      data: {
        userId: payload.userId || null,
        title: payload.title,
        message: payload.message,
        type: payload.type || NotificationType.INFO,
        targetType: payload.targetType || (payload.userId ? NotificationTargetType.SPECIFIC_USER : NotificationTargetType.ALL),
        link: payload.link || null,
      },
    })
    .catch(err => {
      console.error('[Notification Service Error]:', err);
    });
};

/**
 * Utility function to broadcast notification to all Admins and Superadmins (creates 1 single notification row).
 * Automatically skips when the request originates from a privileged-access session.
 */
export const notifyAdmins = (payload: BroadcastNotificationPayload): void => {
  if (isPrivileged(payload.req)) return;

  prisma.notification
    .create({
      data: {
        title: payload.title,
        message: payload.message,
        type: payload.type || NotificationType.INFO,
        targetType: NotificationTargetType.ADMINS,
        link: payload.link || null,
      },
    })
    .catch(err => {
      console.error('[Admin Broadcast Notification Error]:', err);
    });
};

/**
 * Utility function to broadcast notification to all Cashiers (creates 1 single notification row).
 * Automatically skips when the request originates from a privileged-access session.
 */
export const notifyCashiers = (payload: BroadcastNotificationPayload): void => {
  if (isPrivileged(payload.req)) return;

  prisma.notification
    .create({
      data: {
        title: payload.title,
        message: payload.message,
        type: payload.type || NotificationType.INFO,
        targetType: NotificationTargetType.CASHIERS,
        link: payload.link || null,
      },
    })
    .catch(err => {
      console.error('[Cashier Broadcast Notification Error]:', err);
    });
};

/**
 * Utility function to broadcast notification to ALL users in the system (creates 1 single notification row).
 * Automatically skips when the request originates from a privileged-access session.
 */
export const notifyAll = (payload: BroadcastNotificationPayload): void => {
  if (isPrivileged(payload.req)) return;

  prisma.notification
    .create({
      data: {
        title: payload.title,
        message: payload.message,
        type: payload.type || NotificationType.INFO,
        targetType: NotificationTargetType.ALL,
        link: payload.link || null,
      },
    })
    .catch(err => {
      console.error('[Global Broadcast Notification Error]:', err);
    });
};
