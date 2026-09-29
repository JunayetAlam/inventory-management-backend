import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import { cachedMaintenanceState } from '../modules/Maintenance/maintenance.service';
import { validatePrivilegedToken } from '../utils/privilegedAuth';

/**
 * Global maintenance guard middleware.
 * If maintenance is active, all API requests are blocked with HTTP 503
 * UNLESS:
 * 1. The caller supplies a valid privileged token (x-privileged-token or x-secret-token).
 * 2. The endpoint is the public maintenance status route (/api/v1/maintenance/public-status).
 * 3. The route is a static asset or root health check.
 */
const maintenanceGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // If maintenance is not active, proceed without delay
  if (!cachedMaintenanceState.isActive) {
    return next();
  }

  // Check for privileged token first
  const privilegedTokenHeader =
    (req.headers['x-privileged-token'] as string | undefined) ||
    (req.headers['x-secret-token'] as string | undefined);

  if (privilegedTokenHeader && validatePrivilegedToken(privilegedTokenHeader)) {
    req.isPrivilegedAccess = true;
    return next();
  }

  // Whitelist public maintenance status and static paths
  const publicWhitelistedPaths = [
    '/api/v1/maintenance/public-status',
    '/assets',
    '/upload',
    '/favicon.ico',
  ];

  const currentPath = req.originalUrl || req.path || '';

  if (
    publicWhitelistedPaths.some(
      whitelist => currentPath === whitelist || currentPath.startsWith(whitelist + '/'),
    )
  ) {
    return next();
  }

  // System is in maintenance mode and user is not a privileged operator: block request with 503
  res.status(httpStatus.SERVICE_UNAVAILABLE).json({
    success: false,
    statusCode: httpStatus.SERVICE_UNAVAILABLE,
    message:
      cachedMaintenanceState.message ||
      'System is currently under maintenance. Please try again later.',
    data: {
      isMaintenance: true,
      title: cachedMaintenanceState.title,
      message: cachedMaintenanceState.message,
      reason: cachedMaintenanceState.reason,
      estimatedEndTime: cachedMaintenanceState.estimatedEndTime,
      contactEmail: cachedMaintenanceState.contactEmail,
      contactPhone: cachedMaintenanceState.contactPhone,
      supportNotice: cachedMaintenanceState.supportNotice,
    },
  });
};

export default maintenanceGuard;
