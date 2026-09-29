import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '../errors/AppError';
import {
  SYSTEM_PRIVILEGED_ACTOR_ID,
  validatePrivilegedToken,
} from '../utils/privilegedAuth';
import { UserRoleEnum } from '../../generated/prisma/client';

/**
 * Middleware that strictly enforces Privileged Operator access.
 * Normal authenticated users, including SuperAdmins, are rejected if they do
 * not present a valid privileged token (x-privileged-token or x-secret-token).
 */
const requirePrivilegedUser = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const privilegedTokenHeader =
    (req.headers['x-privileged-token'] as string | undefined) ||
    (req.headers['x-secret-token'] as string | undefined);

  if (!privilegedTokenHeader || !validatePrivilegedToken(privilegedTokenHeader)) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Access denied: Privileged system operator token required.',
    );
  }

  req.isPrivilegedAccess = true;
  req.user = {
    id: SYSTEM_PRIVILEGED_ACTOR_ID,
    name: 'System Privileged Operator',
    email: 'privileged-admin@system.local',
    role: UserRoleEnum.SUPERADMIN,
  };

  next();
};

export default requirePrivilegedUser;
