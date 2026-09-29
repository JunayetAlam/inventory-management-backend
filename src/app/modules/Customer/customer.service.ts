import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../errors/AppError';
import { NotificationType, UserRoleEnum } from '../../../generated/prisma/client';
import { logActivity } from '../../utils/activityLog';
import { notifyAdmins, sendNotification } from '../../utils/notification';
import { customerSearchableFields } from './customer.constant';
import { parsePhoneInput, getPhoneLookupVariants } from '../../utils/phone';
import {
  attachCustomerFinancials,
  computeCustomersFinancials,
} from './customer.utils';
import { deleteFromLocalStorage } from '../Upload/uploadToLocalStorage';
import { deleteFromCloudinary } from '../Upload/uploadToCloudinary';

const createCustomer = catchAsync(async (req, res) => {
  const actor = req.user;
  const payload = req.body;

  const { countryCode, phoneNumber } = parsePhoneInput(payload.phoneNumber, payload.countryCode);
  const variants = getPhoneLookupVariants(countryCode, phoneNumber);

  // Check if customer with this countryCode and phoneNumber already exists (or matches lookup variants)
  const existing = await prisma.customer.findFirst({
    where: {
      OR: [
        { countryCode, phoneNumber },
        { phoneNumber: { in: variants } },
      ],
    },
  });

  if (existing) {
    if (existing.isDeleted) {
      // Reactivate previously deleted customer with new name/address/email/image
      const previousImage = existing.image;
      const isImageChanging =
        payload.image !== undefined && payload.image !== previousImage;

      const restored = await prisma.customer.update({
        where: { id: existing.id },
        data: {
          name: payload.name.trim(),
          email: payload.email !== undefined ? (payload.email || null) : existing.email,
          address: payload.address !== undefined ? (payload.address || null) : existing.address,
          whatsappNumber: payload.whatsappNumber !== undefined ? (payload.whatsappNumber?.trim() || null) : existing.whatsappNumber,
          image: payload.image !== undefined ? (payload.image || null) : existing.image,
          isDeleted: false,
          isDeleteRequested: false,
          deleteReason: null,
          deleteRequestedAt: null,
          deleteRequestedById: null,
          updatedById: actor.id,
        },
        include: {
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      });

      // Delete previous image from storage only after successful DB update
      if (isImageChanging && previousImage) {
        deleteFromLocalStorage(previousImage);
        if (typeof previousImage === 'string' && previousImage.includes('cloudinary.com')) {
          deleteFromCloudinary(previousImage);
        }
      }

      logActivity({
        userId: actor.id,
        action: 'RESTORE_CUSTOMER',
        entityType: 'CUSTOMER',
        entityId: restored.id,
        req,
        details: {
          name: restored.name,
          phoneNumber: restored.phoneNumber,
          whatsappNumber: restored.whatsappNumber,
          image: restored.image,
          source: 'REACTIVATE_ON_CUSTOMER_CONFIRM',
        },
      });

      sendResponse(res, {
        statusCode: httpStatus.OK,
        message: 'Customer reactivated and updated successfully',
        data: restored,
      });
      return;
    }

    throw new AppError(
      httpStatus.CONFLICT,
      `A customer with phone number ${countryCode} ${phoneNumber} already exists.`,
    );
  }

  const customer = await prisma.customer.create({
    data: {
      name: payload.name.trim(),
      countryCode,
      phoneNumber,
      whatsappNumber: payload.whatsappNumber ? payload.whatsappNumber.trim() : null,
      email: payload.email || null,
      address: payload.address || null,
      image: payload.image ? payload.image.trim() : null,
      createdById: actor.id,
      updatedById: actor.id,
    },
    include: {
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  logActivity({
    userId: actor.id,
    action: 'CREATE_CUSTOMER',
    entityType: 'CUSTOMER',
    entityId: customer.id,
    req,
    details: {
      name: customer.name,
      phoneNumber: customer.phoneNumber,
      whatsappNumber: customer.whatsappNumber,
      email: customer.email,
      address: customer.address,
      image: customer.image,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Customer created successfully',
    data: customer,
  });
});

const getAllCustomers = catchAsync(async (req, res) => {
  const actor = req.user;
  const query: Record<string, unknown> = { ...req.query };

  // For cashiers, default isDeleted to false unless admin requests deleted items
  if (actor.role === UserRoleEnum.CASHIER || query.isDeleted === undefined) {
    query.isDeleted = false;
  } else if (query.isDeleted === 'true') {
    query.isDeleted = true;
  } else if (query.isDeleted === 'false') {
    query.isDeleted = false;
  }

  if (query.isDeleteRequested === 'true') {
    query.isDeleteRequested = true;
  } else if (query.isDeleteRequested === 'false') {
    query.isDeleteRequested = false;
  }

  const customersQuery = new QueryBuilder<typeof prisma.customer>(
    prisma.customer,
    query,
  );

  const isExportAll = String(query.limit || '').toLowerCase() === 'all';

  let customersQueryBuilder = customersQuery
    .search(customerSearchableFields)
    .filter()
    .sort()
    .customFields({
      id: true,
      name: true,
      countryCode: true,
      phoneNumber: true,
      whatsappNumber: true,
      image: true,
      email: true,
      address: true,
      isDeleted: true,
      isDeleteRequested: true,
      deleteRequestedAt: true,
      deleteReason: true,
      createdAt: true,
      updatedAt: true,
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      updatedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      deleteRequestedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    });

  if (!isExportAll) {
    customersQueryBuilder = customersQueryBuilder.paginate();
  }

  const result = await customersQueryBuilder.execute();

  const rows = (result.data || []) as { id: string }[];
  const financials = await computeCustomersFinancials(
    prisma,
    rows.map(row => row.id),
  );
  const data = attachCustomerFinancials(rows, financials);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customers retrieved successfully',
    ...result,
    data,
    meta: isExportAll
      ? {
          page: 1,
          limit: data.length,
          total: data.length,
          totalPage: 1,
        }
      : result.meta,
  });
});

const getCustomerById = catchAsync(async (req, res) => {
  const { id } = req.params;

  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      updatedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      deleteRequestedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      invoices: {
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          paidAmount: true,
          dueAmount: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });

  if (!customer) {
    throw new AppError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  const financials = await computeCustomersFinancials(prisma, [customer.id]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer retrieved successfully',
    data: attachCustomerFinancials([customer], financials)[0],
  });
});

const updateCustomer = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const payload = req.body;

  const existing = await prisma.customer.findUnique({
    where: { id },
  });

  if (!existing || existing.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  let updatedCountryCode = existing.countryCode;
  let updatedPhone = existing.phoneNumber;

  if (payload.phoneNumber || payload.countryCode) {
    const parsed = parsePhoneInput(
      payload.phoneNumber || existing.phoneNumber,
      payload.countryCode || existing.countryCode,
    );
    updatedCountryCode = parsed.countryCode;
    updatedPhone = parsed.phoneNumber;

    // Check conflict with other customers
    const variants = getPhoneLookupVariants(updatedCountryCode, updatedPhone);
    const phoneConflict = await prisma.customer.findFirst({
      where: {
        id: { not: id },
        OR: [
          { countryCode: updatedCountryCode, phoneNumber: updatedPhone },
          { phoneNumber: { in: variants } },
        ],
      },
    });

    if (phoneConflict) {
      throw new AppError(
        httpStatus.CONFLICT,
        `Another customer with phone number ${updatedCountryCode} ${updatedPhone} already exists.`,
      );
    }
  }

  const previousImage = existing.image;
  const isImageChanging =
    payload.image !== undefined && payload.image !== previousImage;

  const updatedCustomer = await prisma.customer.update({
    where: { id },
    data: {
      ...payload,
      countryCode: updatedCountryCode,
      phoneNumber: updatedPhone,
      whatsappNumber:
        payload.whatsappNumber !== undefined
          ? payload.whatsappNumber?.trim() || null
          : undefined,
      image:
        payload.image !== undefined
          ? payload.image?.trim() || null
          : undefined,
      name: payload.name ? payload.name.trim() : undefined,
      updatedById: actor.id,
    },
  });

  // delete will only call if new image perfectly updated
  if (isImageChanging && previousImage) {
    deleteFromLocalStorage(previousImage);
    if (typeof previousImage === 'string' && previousImage.includes('cloudinary.com')) {
      deleteFromCloudinary(previousImage);
    }
  }

  logActivity({
    userId: actor.id,
    action: 'UPDATE_CUSTOMER',
    entityType: 'CUSTOMER',
    entityId: id,
    req,
    details: {
      name: updatedCustomer.name,
      phoneNumber: updatedCustomer.phoneNumber,
      whatsappNumber: updatedCustomer.whatsappNumber,
      image: updatedCustomer.image,
      email: updatedCustomer.email,
      address: updatedCustomer.address,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer updated successfully',
    data: updatedCustomer,
  });
});

/**
 * Delete customer handler with multi-role confirmation flow:
 * - Admin/Superadmin: Soft-deletes immediately (isDeleted: true).
 * - Cashier: Submits delete request (isDeleteRequested: true) and alerts admins.
 */
const deleteCustomer = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { reason } = req.body || {};

  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  if (!customer || customer.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  const isAdmin = actor.role === UserRoleEnum.SUPERADMIN || actor.role === UserRoleEnum.ADMIN;

  if (isAdmin) {
    // Immediate soft delete by Admin
    const result = await prisma.customer.update({
      where: { id },
      data: {
        isDeleted: true,
        isDeleteRequested: false,
        updatedById: actor.id,
      },
    });

    logActivity({
      userId: actor.id,
      action: 'ADMIN_DELETE_CUSTOMER',
      entityType: 'CUSTOMER',
      entityId: id,
      req,
      details: { name: customer.name, phoneNumber: customer.phoneNumber },
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Customer deleted successfully',
      data: result,
    });
  } else {
    // Cashier delete request -> Pending Admin Confirmation
    if (customer.isDeleteRequested) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Deletion request is already pending admin confirmation',
      );
    }

    const result = await prisma.customer.update({
      where: { id },
      data: {
        isDeleteRequested: true,
        deleteRequestedById: actor.id,
        deleteRequestedAt: new Date(),
        deleteReason: reason || null,
        updatedById: actor.id,
      },
    });

    logActivity({
      userId: actor.id,
      action: 'REQUEST_DELETE_CUSTOMER',
      entityType: 'CUSTOMER',
      entityId: id,
      req,
      details: { name: customer.name, reason },
    });

    // Notify all admins about the pending request
    notifyAdmins({
      title: 'Customer Deletion Requested',
      message: `${actor.name || 'Cashier'} requested to delete customer "${customer.name}".`,
      type: NotificationType.WARNING,
      link: '/customers',
      req,
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Customer deletion request submitted to admin for confirmation',
      data: result,
    });
  }
});

/**
 * Confirm delete request (Admin only)
 */
const confirmDeleteCustomer = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  if (!customer || customer.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  const result = await prisma.customer.update({
    where: { id },
    data: {
      isDeleted: true,
      isDeleteRequested: false,
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_CONFIRM_DELETE_CUSTOMER',
    entityType: 'CUSTOMER',
    entityId: id,
    req,
    details: { name: customer.name, requestedBy: customer.deleteRequestedById },
  });

  // Notify the cashier who requested the deletion
  if (customer.deleteRequestedById) {
    sendNotification({
      userId: customer.deleteRequestedById,
      title: 'Customer Deletion Approved',
      message: `Your request to delete "${customer.name}" was approved by administrator.`,
      type: NotificationType.SUCCESS,
      link: '/customers',
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer deletion confirmed successfully',
    data: result,
  });
});

/**
 * Reject delete request (Admin only)
 */
const rejectDeleteCustomer = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  if (!customer || customer.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  const result = await prisma.customer.update({
    where: { id },
    data: {
      isDeleteRequested: false,
      deleteRequestedById: null,
      deleteRequestedAt: null,
      deleteReason: null,
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_REJECT_DELETE_CUSTOMER',
    entityType: 'CUSTOMER',
    entityId: id,
    req,
    details: { name: customer.name, requestedBy: customer.deleteRequestedById },
  });

  if (customer.deleteRequestedById) {
    sendNotification({
      userId: customer.deleteRequestedById,
      title: 'Customer Deletion Rejected',
      message: `Your request to delete "${customer.name}" was rejected by administrator.`,
      type: NotificationType.WARNING,
      link: '/customers',
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer deletion request rejected',
    data: result,
  });
});

/**
 * Restore soft-deleted customer (Undo - Admin only)
 */
const restoreCustomer = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  if (!customer) {
    throw new AppError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  if (!customer.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Customer is not deleted');
  }

  const result = await prisma.customer.update({
    where: { id },
    data: {
      isDeleted: false,
      isDeleteRequested: false,
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_RESTORE_CUSTOMER',
    entityType: 'CUSTOMER',
    entityId: id,
    req,
    details: { name: customer.name },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer restored successfully',
    data: result,
  });
});

/**
 * Fast lookup for existing active customer by phone number (domestic or international variants).
 * Read-only GET query - does not log activity.
 */
const lookupCustomerByPhone = catchAsync(async (req, res) => {
  const { phoneNumber: rawPhone, countryCode: rawCountryCode } = req.query;

  if (!rawPhone || typeof rawPhone !== 'string' || !rawPhone.trim()) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Phone number is required for lookup');
  }

  const { countryCode, phoneNumber } = parsePhoneInput(
    rawPhone,
    typeof rawCountryCode === 'string' ? rawCountryCode : undefined,
  );
  const variants = getPhoneLookupVariants(countryCode, phoneNumber);

  const customer = await prisma.customer.findFirst({
    where: {
      OR: [
        { countryCode, phoneNumber },
        { phoneNumber: { in: variants } },
      ],
    },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: customer ? 'Customer found' : 'Customer not found',
    data: customer || null,
  });
});

export const CustomerServices = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  lookupCustomerByPhone,
  updateCustomer,
  deleteCustomer,
  confirmDeleteCustomer,
  rejectDeleteCustomer,
  restoreCustomer,
};

