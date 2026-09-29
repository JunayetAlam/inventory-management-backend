import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import {
  TMaintenancePublicStatus,
  TToggleMaintenancePayload,
  TUpdateMaintenancePayload,
} from './maintenance.interface';

// In-memory cache for ultra-fast maintenance checks on every incoming API request
export let cachedMaintenanceState: TMaintenancePublicStatus = {
  isActive: false,
  title: 'System Under Maintenance',
  message:
    'We are currently performing scheduled maintenance to improve our service. We apologize for any inconvenience.',
  reason: null,
  estimatedEndTime: null,
  contactEmail: null,
  contactPhone: null,
  supportNotice: null,
  lastToggledAt: null,
};

/**
 * Initializes the in-memory cache on application boot.
 * Creates the default singleton maintenance record if none exists.
 */
export const initMaintenanceCache = async (): Promise<void> => {
  try {
    let maintenance = await prisma.systemMaintenance.findFirst();

    if (!maintenance) {
      maintenance = await prisma.systemMaintenance.create({
        data: {
          isActive: false,
          title: 'System Under Maintenance',
          message:
            'We are currently performing scheduled maintenance to improve our service. We apologize for any inconvenience.',
        },
      });
    }

    cachedMaintenanceState = {
      isActive: maintenance.isActive,
      title: maintenance.title,
      message: maintenance.message,
      reason: maintenance.reason,
      estimatedEndTime: maintenance.estimatedEndTime,
      contactEmail: maintenance.contactEmail,
      contactPhone: maintenance.contactPhone,
      supportNotice: maintenance.supportNotice,
      lastToggledAt: maintenance.lastToggledAt,
    };
  } catch (error) {
    console.error('[Maintenance Cache Init Error]:', error);
  }
};

/**
 * Public status endpoint — accessible by all users and frontend guards,
 * even when the system is in maintenance mode.
 */
const getPublicMaintenanceStatus = catchAsync(async (_req, res) => {
  // If cache is empty or freshly initialized, fallback to fast cached state
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Maintenance status retrieved successfully',
    data: cachedMaintenanceState,
  });
});

/**
 * Privileged details endpoint — only accessible by privileged users.
 * Returns the full database record including metadata.
 */
const getPrivilegedMaintenanceDetails = catchAsync(async (_req, res) => {
  let record = await prisma.systemMaintenance.findFirst();

  if (!record) {
    record = await prisma.systemMaintenance.create({
      data: {
        isActive: false,
        title: 'System Under Maintenance',
        message:
          'We are currently performing scheduled maintenance to improve our service. We apologize for any inconvenience.',
      },
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Maintenance configuration retrieved successfully',
    data: record,
  });
});

/**
 * Privileged toggle endpoint — toggles maintenance mode on or off.
 */
const toggleMaintenance = catchAsync(async (req, res) => {
  const { isActive } = req.body as TToggleMaintenancePayload;

  const existing = await prisma.systemMaintenance.findFirst();

  let updated;
  if (existing) {
    updated = await prisma.systemMaintenance.update({
      where: { id: existing.id },
      data: {
        isActive,
        lastToggledAt: new Date(),
      },
    });
  } else {
    updated = await prisma.systemMaintenance.create({
      data: {
        isActive,
        lastToggledAt: new Date(),
      },
    });
  }

  // Update in-memory cache immediately
  cachedMaintenanceState = {
    isActive: updated.isActive,
    title: updated.title,
    message: updated.message,
    reason: updated.reason,
    estimatedEndTime: updated.estimatedEndTime,
    contactEmail: updated.contactEmail,
    contactPhone: updated.contactPhone,
    supportNotice: updated.supportNotice,
    lastToggledAt: updated.lastToggledAt,
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: `System maintenance mode ${isActive ? 'activated' : 'deactivated'} successfully`,
    data: updated,
  });
});

/**
 * Privileged update endpoint — updates titles, messages, ETAs, and contact info.
 */
const updateMaintenanceDetails = catchAsync(async (req, res) => {
  const payload = req.body as TUpdateMaintenancePayload;

  const existing = await prisma.systemMaintenance.findFirst();

  const updateData: Record<string, unknown> = {};

  if (payload.title !== undefined) updateData.title = payload.title.trim();
  if (payload.message !== undefined) updateData.message = payload.message.trim();
  if (payload.reason !== undefined)
    updateData.reason = payload.reason ? payload.reason.trim() : null;
  if (payload.estimatedEndTime !== undefined) {
    updateData.estimatedEndTime = payload.estimatedEndTime
      ? new Date(payload.estimatedEndTime)
      : null;
  }
  if (payload.contactEmail !== undefined) {
    updateData.contactEmail = payload.contactEmail
      ? payload.contactEmail.trim().toLowerCase()
      : null;
  }
  if (payload.contactPhone !== undefined) {
    updateData.contactPhone = payload.contactPhone
      ? payload.contactPhone.trim()
      : null;
  }
  if (payload.supportNotice !== undefined) {
    updateData.supportNotice = payload.supportNotice
      ? payload.supportNotice.trim()
      : null;
  }

  let updated;
  if (existing) {
    updated = await prisma.systemMaintenance.update({
      where: { id: existing.id },
      data: updateData,
    });
  } else {
    updated = await prisma.systemMaintenance.create({
      data: {
        ...updateData,
        isActive: false,
      },
    });
  }

  // Update in-memory cache immediately
  cachedMaintenanceState = {
    isActive: updated.isActive,
    title: updated.title,
    message: updated.message,
    reason: updated.reason,
    estimatedEndTime: updated.estimatedEndTime,
    contactEmail: updated.contactEmail,
    contactPhone: updated.contactPhone,
    supportNotice: updated.supportNotice,
    lastToggledAt: updated.lastToggledAt,
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'System maintenance details updated successfully',
    data: updated,
  });
});

export const MaintenanceServices = {
  getPublicMaintenanceStatus,
  getPrivilegedMaintenanceDetails,
  toggleMaintenance,
  updateMaintenanceDetails,
};
