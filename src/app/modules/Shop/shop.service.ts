import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import { logActivity } from '../../utils/activityLog';
import { deleteFromLocalStorage } from '../Upload/uploadToLocalStorage';

const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
};

const getShopDetails = catchAsync(async (req, res) => {
  const result = await prisma.shop.findFirst({
    include: {
      createdBy: {
        select: userSelect,
      },
      updatedBy: {
        select: userSelect,
      },
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: result ? 'Shop details retrieved successfully' : 'No shop details configured yet',
    data: result || null,
  });
});

const upsertShopDetails = catchAsync(async (req, res) => {
  const actor = req.user;
  const payload = req.body;

  const sanitizedData = {
    name: payload.name.trim(),
    proprietor: payload.proprietor ? payload.proprietor.trim() : null,
    logo: payload.logo ? payload.logo.trim() : null,
    phoneNumbers: Array.isArray(payload.phoneNumbers)
      ? payload.phoneNumbers.map((p: string) => p.trim()).filter(Boolean)
      : [],
    emails: Array.isArray(payload.emails)
      ? payload.emails.map((e: string) => e.trim().toLowerCase()).filter(Boolean)
      : [],
    locations: Array.isArray(payload.locations)
      ? payload.locations.map((l: string) => l.trim()).filter(Boolean)
      : [],
  };

  const existing = await prisma.shop.findFirst();

  let result;
  if (existing) {
    // If shop logo is being changed or cleared, remove previous image from storage
    if (existing.logo && existing.logo !== sanitizedData.logo) {
      deleteFromLocalStorage(existing.logo);
    }

    result = await prisma.shop.update({
      where: {
        id: existing.id,
      },
      data: {
        ...sanitizedData,
        updatedById: actor.id,
      },
      include: {
        createdBy: {
          select: userSelect,
        },
        updatedBy: {
          select: userSelect,
        },
      },
    });

    logActivity({
      userId: actor.id,
      action: 'UPDATE_SHOP_DETAILS',
      entityType: 'SHOP',
      entityId: existing.id,
      details: {
        name: result.name,
        phoneCount: result.phoneNumbers.length,
        emailCount: result.emails.length,
        locationCount: result.locations.length,
      },
      req,
    });
  } else {
    result = await prisma.shop.create({
      data: {
        ...sanitizedData,
        createdById: actor.id,
        updatedById: actor.id,
      },
      include: {
        createdBy: {
          select: userSelect,
        },
        updatedBy: {
          select: userSelect,
        },
      },
    });

    logActivity({
      userId: actor.id,
      action: 'CREATE_SHOP_DETAILS',
      entityType: 'SHOP',
      entityId: result.id,
      details: {
        name: result.name,
        phoneCount: result.phoneNumbers.length,
        emailCount: result.emails.length,
        locationCount: result.locations.length,
      },
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Shop details saved successfully',
    data: result,
  });
});

export const ShopServices = {
  getShopDetails,
  upsertShopDetails,
};
