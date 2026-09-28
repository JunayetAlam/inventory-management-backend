import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../errors/AppError';
import {
  CustomerTransactionType,
  NotificationType,
  ReceiptStatus,
  UserRoleEnum,
} from '../../../generated/prisma/client';
import { logActivity } from '../../utils/activityLog';
import { notifyAdmins, sendNotification } from '../../utils/notification';
import { receiptSearchableFields } from './receipt.constant';
import {
  applyStockDeltaMap,
  areReceiptItemsChanged,
  calculateReceiptTotals,
  deductStockForProductItems,
  generateReceiptNumber,
  getReceiptItemsUniquenessError,
  restoreStockForProductItems,
  roundToTwo,
} from './receipt.utils';
import { parsePhoneInput, getPhoneLookupVariants } from '../../utils/phone';
import {
  deriveMoneyForReturnInvoice,
  withDerivedReturnMoney,
} from '../ReturnInvoice/returnInvoice.utils';

/**
 * Create a new receipt with automatic pricing, per-item percentage discount,
 * overall receipt discount, payment tracking, and safe inventory deduction.
 */
const createReceipt = catchAsync(async (req, res) => {
  const actor = req.user;
  const {
    customerId,
    countryCode: providedCountryCode,
    customerPhone,
    customerName,
    customerAddress,
    customerEmail,
    items,
    discount = 0,
    paidAmount = 0,
    note,
  } = req.body;

  // 1. Resolve or auto-create customer (Domestic or International)
  let customer: any = null;

  if (customerId) {
    customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer || customer.isDeleted) {
      throw new AppError(httpStatus.NOT_FOUND, 'Customer not found or is inactive');
    }
  } else if (customerPhone) {
    const { countryCode, phoneNumber } = parsePhoneInput(customerPhone, providedCountryCode);
    const variants = getPhoneLookupVariants(countryCode, phoneNumber);

    // Look for existing customer by exact match or variants
    customer = await prisma.customer.findFirst({
      where: {
        OR: [
          { countryCode, phoneNumber },
          { phoneNumber: { in: variants } },
        ],
      },
    });

    if (!customer) {
      // Auto-create new customer on the fly
      customer = await prisma.customer.create({
        data: {
          name: customerName?.trim() || `Customer-${phoneNumber.slice(-4)}`,
          countryCode,
          phoneNumber,
          address: customerAddress?.trim() || null,
          email: customerEmail?.trim() || null,
          createdById: actor.id,
          updatedById: actor.id,
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
          countryCode: customer.countryCode,
          phoneNumber: customer.phoneNumber,
          source: 'AUTO_RECEIPT_CREATION',
        },
      });
    } else if (customer.isDeleted) {
      // Auto-restore customer if previously deleted with new details
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          isDeleted: false,
          isDeleteRequested: false,
          deleteReason: null,
          deleteRequestedAt: null,
          deleteRequestedById: null,
          name: customerName?.trim() || customer.name,
          address: customerAddress !== undefined ? (customerAddress?.trim() || null) : customer.address,
          email: customerEmail !== undefined ? (customerEmail?.trim() || null) : customer.email,
          updatedById: actor.id,
        },
      });

      logActivity({
        userId: actor.id,
        action: 'RESTORE_CUSTOMER',
        entityType: 'CUSTOMER',
        entityId: customer.id,
        req,
        details: {
          name: customer.name,
          countryCode: customer.countryCode,
          phoneNumber: customer.phoneNumber,
          source: 'AUTO_RECEIPT_CREATION',
        },
      });
    }
  }

  if (!customer) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Valid customerId or customerPhone is required');
  }

  const duplicateProductError = getReceiptItemsUniquenessError(items);
  if (duplicateProductError) {
    throw new AppError(httpStatus.BAD_REQUEST, duplicateProductError);
  }

  // 2. Fetch linked products from DB if productId is provided
  const productIds = items
    .map((it: { productId?: string }) => it.productId)
    .filter(Boolean) as string[];

  const dbProducts = productIds.length > 0
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
      })
    : [];

  const productMap = new Map(dbProducts.map(p => [p.id, p]));

  // 3. Prepare items with accurate defaults
  const enrichedItems = items.map((it: any) => {
    const dbProduct = it.productId ? productMap.get(it.productId) : null;
    return {
      productId: it.productId || null,
      productName: it.productName || dbProduct?.name || 'Unknown Product',
      unit: it.unit || dbProduct?.unit || 'PIECE',
      sellingPrice: it.sellingPrice !== undefined ? it.sellingPrice : (dbProduct?.sellingPrice ?? 0),
      buyingPrice: it.buyingPrice !== undefined ? it.buyingPrice : (dbProduct?.buyingPrice ?? null),
      quantity: it.quantity,
      discounts: it.discounts || (it.discount ? [it.discount] : []),
    };
  });

  // 4. Calculate items total, discounts, and due
  const {
    calculatedItems,
    subTotal,
    discount: totalDiscount,
    totalAmount,
    paidAmount: finalPaidAmount,
    dueAmount,
  } = calculateReceiptTotals(enrichedItems, discount, paidAmount);

  // 5. Execute transaction for Receipt, Items, Payment, and Stock updates
  const warnings: string[] = [];

  const result = await prisma.$transaction(async tx => {
    // Generate unique receipt number
    const receiptNumber = await generateReceiptNumber(tx);

    // Deduct inventory stock (aggregated by productId; may go negative on oversell)
    await deductStockForProductItems(tx, calculatedItems, warnings);

    // Create Receipt header
    const receipt = await tx.receipt.create({
      data: {
        receiptNumber,
        customerId: customer.id,
        subTotal,
        discount: totalDiscount,
        totalAmount,
        paidAmount: finalPaidAmount,
        dueAmount,
        status: ReceiptStatus.PENDING,
        note: note || null,
        createdById: actor.id,
        updatedById: actor.id,
      },
    });

    // Create Receipt Items
    await tx.receiptItem.createMany({
      data: calculatedItems.map(item => ({
        receiptId: receipt.id,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        sellingPrice: item.sellingPrice,
        buyingPrice: item.buyingPrice,
        quantity: item.quantity,
        discounts: item.discounts,
        totalPrice: item.totalPrice,
      })),
    });

    // Create CustomerTransaction for Receipt
    await tx.customerTransaction.create({
      data: {
        customerId: customer.id,
        type: CustomerTransactionType.RECEIPT,
        receiptId: receipt.id,
        note: note || null,
        createdById: actor.id,
      },
    });

    // If initial payment was made, record it as the first payment entry and create CustomerTransaction for Payment
    if (finalPaidAmount > 0) {
      const initialPayment = await tx.receiptPayment.create({
        data: {
          receiptId: receipt.id,
          amount: finalPaidAmount,
          note: 'Initial payment upon receipt creation',
          createdById: actor.id,
        },
      });

      await tx.customerTransaction.create({
        data: {
          customerId: customer.id,
          type: CustomerTransactionType.PAYMENT,
          receiptId: receipt.id,
          paymentId: initialPayment.id,
          note: initialPayment.note || null,
          createdById: actor.id,
        },
      });
    }

    // Return complete receipt
    return tx.receipt.findUnique({
      where: { id: receipt.id },
      include: {
        customer: {
          select: { id: true, name: true, phoneNumber: true, email: true, address: true },
        },
        items: true,
        payments: true,
        createdBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
  });

  // 6. Non-blocking Activity Log and Notifications
  logActivity({
    userId: actor.id,
    action: 'CREATE_RECEIPT',
    entityType: 'RECEIPT',
    entityId: result?.id,
    req,
    details: {
      receiptNumber: result?.receiptNumber,
      totalAmount,
      paidAmount: finalPaidAmount,
      dueAmount,
      customerId: customer.id,
      itemCount: calculatedItems.length,
      warningsCount: warnings.length,
    },
  });

  notifyAdmins({
    title: 'New Receipt Created',
    message: `Receipt ${result?.receiptNumber} created for ${customer.name} (৳${totalAmount}).`,
    type: NotificationType.INFO,
    link: `/receipts/${result?.id}`,
  });

  sendNotification({
    userId: actor.id,
    title: 'Receipt Created',
    message: `Receipt ${result?.receiptNumber} has been generated successfully.`,
    type: NotificationType.SUCCESS,
    link: `/receipts/${result?.id}`,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Receipt created successfully',
    data: {
      receipt: result,
      warnings,
    },
  });
});

/**
 * Get all receipts with searching, filtering, and role awareness
 */
const getAllReceipts = catchAsync(async (req, res) => {
  const actor = req.user;
  const query: Record<string, unknown> = { ...req.query };

  // For cashiers, default isDeleted to false unless admin explicitly requests
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

  const receiptsQuery = new QueryBuilder<typeof prisma.receipt>(
    prisma.receipt,
    query,
  );

  const result = await receiptsQuery
    .search(receiptSearchableFields)
    .filter()
    .sort()
    .customFields({
      id: true,
      receiptNumber: true,
      customerId: true,
      subTotal: true,
      discount: true,
      totalAmount: true,
      paidAmount: true,
      dueAmount: true,
      status: true,
      note: true,
      isDeleted: true,
      isDeleteRequested: true,
      deleteRequestedAt: true,
      deleteReason: true,
      createdAt: true,
      updatedAt: true,
      customer: {
        select: {
          id: true,
          name: true,
          countryCode: true,
          phoneNumber: true,
        },
      },
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
      _count: {
        select: {
          items: true,
          payments: true,
        },
      },
    })
    .paginate()
    .execute();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Receipts retrieved successfully',
    ...result,
  });
});

/**
 * Get a single receipt by ID with full item details and payment history
 */
const getReceiptById = catchAsync(async (req, res) => {
  const { id } = req.params;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
    include: {
      customer: true,
      items: {
        include: {
          product: {
            select: { id: true, name: true, stock: true, unit: true },
          },
        },
      },
      payments: {
        include: {
          createdBy: {
            select: { id: true, firstName: true, lastName: true },
          },
          approvedBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      returnInvoices: {
        where: { isDeleted: false },
        include: {
          items: true,
          createdBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      createdBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      updatedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      deleteRequestedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  if (!receipt) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found');
  }

  const returnedQtyMap = new Map<string, number>();
  for (const ret of receipt.returnInvoices) {
    for (const item of ret.items) {
      returnedQtyMap.set(
        item.receiptItemId,
        roundToTwo((returnedQtyMap.get(item.receiptItemId) || 0) + item.quantity),
      );
    }
  }

  const itemsWithReturnMeta = receipt.items.map(it => {
    const alreadyReturned = returnedQtyMap.get(it.id) || 0;
    return {
      ...it,
      alreadyReturned,
      remainingReturnable: roundToTwo(Math.max(0, it.quantity - alreadyReturned)),
    };
  });

  const moneyCache = new Map();
  const returnInvoicesWithMoney = [];
  for (const ret of receipt.returnInvoices) {
    const money = await deriveMoneyForReturnInvoice(prisma, ret.id, moneyCache);
    returnInvoicesWithMoney.push(withDerivedReturnMoney(ret, money));
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Receipt retrieved successfully',
    data: {
      ...receipt,
      items: itemsWithReturnMeta,
      returnInvoices: returnInvoicesWithMoney,
    },
  });
});

/**
 * Update receipt with Role-Based Guard (Approved locked for cashier)
 * and differential stock synchronization.
 */
const updateReceipt = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const payload = req.body;

  const existing = await prisma.receipt.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!existing || existing.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found or is deleted');
  }

  // 1. Role-Based Guard: Cashiers CANNOT edit an APPROVED receipt
  if (existing.status === ReceiptStatus.APPROVED && actor.role === UserRoleEnum.CASHIER) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Approved receipts are locked and cannot be edited by cashiers. Please contact an administrator.',
    );
  }

  const itemsChanged =
    payload.items && Array.isArray(payload.items)
      ? areReceiptItemsChanged(existing.items, payload.items)
      : false;

  if (itemsChanged) {
    const activeReturnCount = await prisma.returnInvoice.count({
      where: { receiptId: id, isDeleted: false },
    });
    if (activeReturnCount > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Cannot change receipt items while return invoices exist for this receipt. Delete or adjust returns first.',
      );
    }
  }

  // Resolve customer if customerId or customerPhone provided
  let customerIdToUpdate: string | undefined = undefined;

  if (payload.customerId) {
    const cust = await prisma.customer.findUnique({ where: { id: payload.customerId } });
    if (!cust || cust.isDeleted) {
      throw new AppError(httpStatus.NOT_FOUND, 'Customer not found or is inactive');
    }
    customerIdToUpdate = cust.id;
  } else if (payload.customerPhone) {
    const { countryCode, phoneNumber } = parsePhoneInput(payload.customerPhone, payload.countryCode);
    const variants = getPhoneLookupVariants(countryCode, phoneNumber);

    let cust = await prisma.customer.findFirst({
      where: {
        OR: [
          { countryCode, phoneNumber },
          { phoneNumber: { in: variants } },
        ],
      },
    });

    if (!cust) {
      cust = await prisma.customer.create({
        data: {
          name: payload.customerName?.trim() || `Customer-${phoneNumber.slice(-4)}`,
          countryCode,
          phoneNumber,
          address: payload.customerAddress?.trim() || null,
          email: payload.customerEmail?.trim() || null,
          createdById: actor.id,
          updatedById: actor.id,
        },
      });

      logActivity({
        userId: actor.id,
        action: 'CREATE_CUSTOMER',
        entityType: 'CUSTOMER',
        entityId: cust.id,
        req,
        details: {
          name: cust.name,
          countryCode: cust.countryCode,
          phoneNumber: cust.phoneNumber,
          source: 'AUTO_RECEIPT_UPDATE',
        },
      });
    } else if (cust.isDeleted) {
      cust = await prisma.customer.update({
        where: { id: cust.id },
        data: {
          isDeleted: false,
          isDeleteRequested: false,
          deleteReason: null,
          deleteRequestedAt: null,
          deleteRequestedById: null,
          name: payload.customerName?.trim() || cust.name,
          address: payload.customerAddress !== undefined ? (payload.customerAddress?.trim() || null) : cust.address,
          email: payload.customerEmail !== undefined ? (payload.customerEmail?.trim() || null) : cust.email,
          updatedById: actor.id,
        },
      });

      logActivity({
        userId: actor.id,
        action: 'RESTORE_CUSTOMER',
        entityType: 'CUSTOMER',
        entityId: cust.id,
        req,
        details: {
          name: cust.name,
          countryCode: cust.countryCode,
          phoneNumber: cust.phoneNumber,
          source: 'AUTO_RECEIPT_UPDATE',
        },
      });
    }

    customerIdToUpdate = cust.id;
  }

  if (payload.items && Array.isArray(payload.items)) {
    const duplicateProductError = getReceiptItemsUniquenessError(payload.items);
    if (duplicateProductError) {
      throw new AppError(httpStatus.BAD_REQUEST, duplicateProductError);
    }
  }

  const warnings: string[] = [];

  const updatedResult = await prisma.$transaction(async tx => {
    let subTotal = existing.subTotal;
    let totalAmount = existing.totalAmount;
    let dueAmount = existing.dueAmount;
    const finalDiscount = payload.discount !== undefined ? roundToTwo(payload.discount) : existing.discount;

    // 2. If items are being updated, handle differential inventory stock adjustment
    if (itemsChanged && payload.items && Array.isArray(payload.items)) {
      // Build old quantity map for DB products
      const oldQtyMap = new Map<string, number>();
      existing.items.forEach(it => {
        if (it.productId) {
          oldQtyMap.set(it.productId, (oldQtyMap.get(it.productId) || 0) + it.quantity);
        }
      });

      // Recalculate new totals
      const totals = calculateReceiptTotals(payload.items, finalDiscount, existing.paidAmount);
      subTotal = totals.subTotal;
      totalAmount = totals.totalAmount;
      dueAmount = totals.dueAmount;

      // Build new quantity map
      const newQtyMap = new Map<string, number>();
      totals.calculatedItems.forEach(it => {
        if (it.productId) {
          newQtyMap.set(it.productId, (newQtyMap.get(it.productId) || 0) + it.quantity);
        }
      });

      // Stock delta: positive = restore, negative = deduct more
      const stockDeltaMap = new Map<string, number>();
      const allProductIds = new Set([...oldQtyMap.keys(), ...newQtyMap.keys()]);

      for (const productId of allProductIds) {
        const oldQty = oldQtyMap.get(productId) || 0;
        const newQty = newQtyMap.get(productId) || 0;
        const stockDelta = roundToTwo(oldQty - newQty);
        if (stockDelta !== 0) {
          stockDeltaMap.set(productId, stockDelta);
        }
      }

      await applyStockDeltaMap(tx, stockDeltaMap, warnings);

      // Clean up any orphaned return invoice items belonging to deleted return invoices for this receipt
      await tx.returnInvoiceItem.deleteMany({
        where: { receiptId: id },
      });

      // Delete old items and insert updated items
      await tx.receiptItem.deleteMany({ where: { receiptId: id } });
      await tx.receiptItem.createMany({
        data: totals.calculatedItems.map(item => ({
          receiptId: id,
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          sellingPrice: item.sellingPrice,
          buyingPrice: item.buyingPrice,
          quantity: item.quantity,
          discounts: item.discounts,
          totalPrice: item.totalPrice,
        })),
      });
    } else if (payload.discount !== undefined || payload.items) {
      // Items didn't change (or only discount changed) -> recalculate totals cleanly
      const totals = calculateReceiptTotals(
        existing.items.map(it => ({
          productId: it.productId,
          productName: it.productName,
          unit: it.unit,
          sellingPrice: it.sellingPrice,
          buyingPrice: it.buyingPrice,
          quantity: it.quantity,
          discounts: it.discounts,
        })),
        finalDiscount,
        existing.paidAmount,
      );
      subTotal = totals.subTotal;
      totalAmount = totals.totalAmount;
      dueAmount = totals.dueAmount;
    }

    // 3. Update receipt record
    const updatedReceipt = await tx.receipt.update({
      where: { id },
      data: {
        customerId: customerIdToUpdate || undefined,
        status:
          actor.role === UserRoleEnum.CASHIER
            ? undefined
            : payload.status || undefined,
        note: payload.note !== undefined ? payload.note : undefined,
        subTotal,
        discount: finalDiscount,
        totalAmount,
        dueAmount,
        updatedById: actor.id,
      },
      include: {
        customer: true,
        items: true,
        payments: true,
      },
    });

    return updatedReceipt;
  });

  logActivity({
    userId: actor.id,
    action: 'UPDATE_RECEIPT',
    entityType: 'RECEIPT',
    entityId: id,
    req,
    details: {
      receiptNumber: updatedResult.receiptNumber,
      totalAmount: updatedResult.totalAmount,
      dueAmount: updatedResult.dueAmount,
      warningsCount: warnings.length,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Receipt updated successfully',
    data: {
      receipt: updatedResult,
      warnings,
    },
  });
});

/**
 * Delete receipt handler:
 * - Admin/Superadmin: Immediate soft-delete and automatically restores inventory stock.
 * - Cashier: Submits delete request (isDeleteRequested: true) and notifies admins.
 */
const deleteReceipt = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { reason } = req.body || {};

  const receipt = await prisma.receipt.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found');
  }

  const activeReturnCount = await prisma.returnInvoice.count({
    where: { receiptId: id, isDeleted: false },
  });
  if (activeReturnCount > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot delete this receipt while return invoices exist. Delete the return invoices first.',
    );
  }

  const isAdmin = actor.role === UserRoleEnum.SUPERADMIN || actor.role === UserRoleEnum.ADMIN;

  if (isAdmin) {
    // Immediate soft delete by Admin with inventory restoration
    const result = await prisma.$transaction(async tx => {
      await restoreStockForProductItems(tx, receipt.items, []);

      return tx.receipt.update({
        where: { id },
        data: {
          isDeleted: true,
          isDeleteRequested: false,
          updatedById: actor.id,
        },
      });
    });

    logActivity({
      userId: actor.id,
      action: 'ADMIN_DELETE_RECEIPT',
      entityType: 'RECEIPT',
      entityId: id,
      req,
      details: { receiptNumber: receipt.receiptNumber, totalAmount: receipt.totalAmount },
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Receipt deleted successfully and product inventory has been restored',
      data: result,
    });
  } else {
    // Cashier delete request -> Pending Admin Confirmation
    if (receipt.isDeleteRequested) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Deletion request is already pending admin confirmation',
      );
    }

    const result = await prisma.receipt.update({
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
      action: 'REQUEST_DELETE_RECEIPT',
      entityType: 'RECEIPT',
      entityId: id,
      req,
      details: { receiptNumber: receipt.receiptNumber, reason },
    });

    notifyAdmins({
      title: 'Receipt Deletion Requested',
      message: `${actor.name || 'Cashier'} requested deletion of Receipt ${receipt.receiptNumber}.`,
      type: NotificationType.WARNING,
      link: `/receipts/${id}`,
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Receipt deletion request submitted to admin for confirmation',
      data: result,
    });
  }
});

/**
 * Confirm delete request (Admin only) and restore inventory stock
 */
const confirmDeleteReceipt = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found');
  }

  const activeReturnCount = await prisma.returnInvoice.count({
    where: { receiptId: id, isDeleted: false },
  });
  if (activeReturnCount > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot delete this receipt while return invoices exist. Delete the return invoices first.',
    );
  }

  const result = await prisma.$transaction(async tx => {
    await restoreStockForProductItems(tx, receipt.items, []);

    return tx.receipt.update({
      where: { id },
      data: {
        isDeleted: true,
        isDeleteRequested: false,
        updatedById: actor.id,
      },
    });
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_CONFIRM_DELETE_RECEIPT',
    entityType: 'RECEIPT',
    entityId: id,
    req,
    details: { receiptNumber: receipt.receiptNumber },
  });

  if (receipt.deleteRequestedById) {
    sendNotification({
      userId: receipt.deleteRequestedById,
      title: 'Receipt Deletion Confirmed',
      message: `Admin confirmed deletion for Receipt ${receipt.receiptNumber}.`,
      type: NotificationType.SUCCESS,
      link: `/receipts`,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Receipt deletion confirmed and inventory stock restored',
    data: result,
  });
});

/**
 * Reject delete request (Admin only)
 */
const rejectDeleteReceipt = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found');
  }

  const result = await prisma.receipt.update({
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
    action: 'ADMIN_REJECT_DELETE_RECEIPT',
    entityType: 'RECEIPT',
    entityId: id,
    req,
    details: { receiptNumber: receipt.receiptNumber },
  });

  if (receipt.deleteRequestedById) {
    sendNotification({
      userId: receipt.deleteRequestedById,
      title: 'Receipt Deletion Rejected',
      message: `Admin rejected deletion request for Receipt ${receipt.receiptNumber}.`,
      type: NotificationType.WARNING,
      link: `/receipts/${id}`,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Receipt deletion request rejected',
    data: result,
  });
});

/**
 * Restore / Undo soft-deleted receipt (Admin only) and re-deduct inventory
 */
const restoreReceipt = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!receipt || !receipt.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Receipt is not in deleted state');
  }

  const warnings: string[] = [];

  const result = await prisma.$transaction(async tx => {
    await deductStockForProductItems(tx, receipt.items, warnings);

    return tx.receipt.update({
      where: { id },
      data: {
        isDeleted: false,
        isDeleteRequested: false,
        deleteRequestedById: null,
        deleteRequestedAt: null,
        deleteReason: null,
        updatedById: actor.id,
      },
    });
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_RESTORE_RECEIPT',
    entityType: 'RECEIPT',
    entityId: id,
    req,
    details: { receiptNumber: receipt.receiptNumber },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Receipt restored successfully',
    data: {
      receipt: result,
      warnings,
    },
  });
});

/**
 * Add partial or full installment payment towards customer due amount
 */
const addPayment = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { amount, note, date } = req.body;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found or is deleted');
  }

  if (receipt.dueAmount <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'This receipt is already fully paid');
  }

  const paymentAmount = roundToTwo(amount);

  if (paymentAmount > receipt.dueAmount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Payment amount (৳${paymentAmount}) exceeds remaining due amount (৳${receipt.dueAmount})`,
    );
  }

  const result = await prisma.$transaction(async tx => {
    // 1. Create ReceiptPayment entry with timestamp
    const payment = await tx.receiptPayment.create({
      data: {
        receiptId: id,
        amount: paymentAmount,
        note: note || null,
        createdById: actor.id,
        createdAt: date ? new Date(date) : undefined,
      },
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    // Create CustomerTransaction for Payment
    await tx.customerTransaction.create({
      data: {
        customerId: receipt.customerId,
        type: CustomerTransactionType.PAYMENT,
        receiptId: receipt.id,
        paymentId: payment.id,
        note: note || null,
        createdById: actor.id,
        createdAt: date ? new Date(date) : undefined,
      },
    });

    // 2. Update Receipt totals
    const newPaidAmount = roundToTwo(receipt.paidAmount + paymentAmount);
    const newDueAmount = roundToTwo(Math.max(0, receipt.totalAmount - newPaidAmount));

    const updatedReceipt = await tx.receipt.update({
      where: { id },
      data: {
        paidAmount: newPaidAmount,
        dueAmount: newDueAmount,
        updatedById: actor.id,
      },
      include: {
        customer: true,
        items: {
          include: {
            product: {
              select: { id: true, name: true, stock: true, unit: true },
            },
          },
        },
        payments: {
          orderBy: { createdAt: 'asc' },
          include: {
            createdBy: {
              select: { id: true, firstName: true, lastName: true },
            },
            approvedBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
      },
    });

    return { payment, receipt: updatedReceipt };
  });

  logActivity({
    userId: actor.id,
    action: 'ADD_RECEIPT_PAYMENT',
    entityType: 'RECEIPT_PAYMENT',
    entityId: result.payment.id,
    req,
    details: {
      receiptId: id,
      receiptNumber: receipt.receiptNumber,
      amount: paymentAmount,
      remainingDue: result.receipt.dueAmount,
    },
  });

  sendNotification({
    userId: actor.id,
    title: 'Payment Received',
    message: `Payment of ৳${paymentAmount} recorded for Receipt ${receipt.receiptNumber}. Remaining due: ৳${result.receipt.dueAmount}.`,
    type: NotificationType.SUCCESS,
    link: `/receipts/${id}`,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Payment recorded successfully',
    data: result,
  });
});

/**
 * Update an existing payment on a receipt
 */
const updatePayment = catchAsync(async (req, res) => {
  const { id, paymentId } = req.params;
  const actor = req.user;
  const { amount, note, date } = req.body;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found or is deleted');
  }

  const existingPayment = await prisma.receiptPayment.findUnique({
    where: { id: paymentId },
  });

  if (!existingPayment || existingPayment.receiptId !== id) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment record not found for this receipt');
  }

  if (existingPayment.status === ReceiptStatus.APPROVED) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Approved payments cannot be edited');
  }

  const newAmount = amount !== undefined ? roundToTwo(amount) : existingPayment.amount;
  const diff = roundToTwo(newAmount - existingPayment.amount);

  if (diff > receipt.dueAmount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Payment increase of ৳${diff} exceeds remaining due amount (৳${receipt.dueAmount})`,
    );
  }

  const result = await prisma.$transaction(async tx => {
    // 1. Update ReceiptPayment
    const updatedPayment = await tx.receiptPayment.update({
      where: { id: paymentId },
      data: {
        amount: newAmount,
        note: note !== undefined ? (note || null) : existingPayment.note,
        createdAt: date ? new Date(date) : undefined,
      },
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        approvedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    // Update associated customer transaction note/createdAt if changed
    await tx.customerTransaction.updateMany({
      where: { paymentId },
      data: {
        note: note !== undefined ? (note || null) : existingPayment.note,
        createdAt: date ? new Date(date) : undefined,
      },
    });

    // 2. Update Receipt totals
    const newPaidAmount = roundToTwo(receipt.paidAmount + diff);
    const newDueAmount = roundToTwo(Math.max(0, receipt.totalAmount - newPaidAmount));

    const updatedReceipt = await tx.receipt.update({
      where: { id },
      data: {
        paidAmount: newPaidAmount,
        dueAmount: newDueAmount,
        updatedById: actor.id,
      },
      include: {
        customer: true,
        items: {
          include: {
            product: {
              select: { id: true, name: true, stock: true, unit: true },
            },
          },
        },
        payments: {
          orderBy: { createdAt: 'asc' },
          include: {
            createdBy: {
              select: { id: true, firstName: true, lastName: true },
            },
            approvedBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
      },
    });

    return { payment: updatedPayment, receipt: updatedReceipt };
  });

  logActivity({
    userId: actor.id,
    action: 'UPDATE_RECEIPT_PAYMENT',
    entityType: 'RECEIPT_PAYMENT',
    entityId: paymentId,
    req,
    details: {
      receiptId: id,
      receiptNumber: receipt.receiptNumber,
      oldAmount: existingPayment.amount,
      newAmount,
      diff,
      remainingDue: result.receipt.dueAmount,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Payment updated successfully',
    data: result,
  });
});

/**
 * Delete an existing payment on a receipt and restore due amount
 */
const deletePayment = catchAsync(async (req, res) => {
  const { id, paymentId } = req.params;
  const actor = req.user;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found or is deleted');
  }

  const existingPayment = await prisma.receiptPayment.findUnique({
    where: { id: paymentId },
  });

  if (!existingPayment || existingPayment.receiptId !== id) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment record not found for this receipt');
  }

  if (existingPayment.status === ReceiptStatus.APPROVED) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Approved payments cannot be deleted');
  }

  const result = await prisma.$transaction(async tx => {
    // 1. Delete payment
    await tx.receiptPayment.delete({
      where: { id: paymentId },
    });

    // Delete associated customer transaction
    await tx.customerTransaction.deleteMany({
      where: { paymentId },
    });

    // 2. Revert paid and due amounts
    const newPaidAmount = roundToTwo(Math.max(0, receipt.paidAmount - existingPayment.amount));
    const newDueAmount = roundToTwo(Math.max(0, receipt.totalAmount - newPaidAmount));

    const updatedReceipt = await tx.receipt.update({
      where: { id },
      data: {
        paidAmount: newPaidAmount,
        dueAmount: newDueAmount,
        updatedById: actor.id,
      },
      include: {
        customer: true,
        items: {
          include: {
            product: {
              select: { id: true, name: true, stock: true, unit: true },
            },
          },
        },
        payments: {
          orderBy: { createdAt: 'asc' },
          include: {
            createdBy: {
              select: { id: true, firstName: true, lastName: true },
            },
            approvedBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
      },
    });

    return { deletedPaymentId: paymentId, receipt: updatedReceipt };
  });

  logActivity({
    userId: actor.id,
    action: 'DELETE_RECEIPT_PAYMENT',
    entityType: 'RECEIPT_PAYMENT',
    entityId: paymentId,
    req,
    details: {
      receiptId: id,
      receiptNumber: receipt.receiptNumber,
      amount: existingPayment.amount,
      remainingDue: result.receipt.dueAmount,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Payment deleted successfully',
    data: result,
  });
});

/**
 * Approve a payment (Admin/Superadmin only)
 */
const approvePayment = catchAsync(async (req, res) => {
  const { id, paymentId } = req.params;
  const actor = req.user;

  // Enforce Admin / Superadmin
  if (actor.role !== UserRoleEnum.ADMIN && actor.role !== UserRoleEnum.SUPERADMIN) {
    throw new AppError(httpStatus.FORBIDDEN, 'Only Admin and Super Admin can approve payments');
  }

  const receipt = await prisma.receipt.findUnique({
    where: { id },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found or is deleted');
  }

  const existingPayment = await prisma.receiptPayment.findUnique({
    where: { id: paymentId },
  });

  if (!existingPayment || existingPayment.receiptId !== id) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment record not found for this receipt');
  }

  if (existingPayment.status === ReceiptStatus.APPROVED) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Payment is already approved');
  }

  const updatedPayment = await prisma.receiptPayment.update({
    where: { id: paymentId },
    data: {
      status: ReceiptStatus.APPROVED,
      approvedById: actor.id,
      approvedAt: new Date(),
    },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      approvedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  const updatedReceipt = await prisma.receipt.findUnique({
    where: { id },
    include: {
      customer: true,
      items: {
        include: {
          product: {
            select: { id: true, name: true, stock: true, unit: true },
          },
        },
      },
      payments: {
        orderBy: { createdAt: 'asc' },
        include: {
          createdBy: {
            select: { id: true, firstName: true, lastName: true },
          },
          approvedBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
  });

  logActivity({
    userId: actor.id,
    action: 'APPROVE_RECEIPT_PAYMENT',
    entityType: 'RECEIPT_PAYMENT',
    entityId: paymentId,
    req,
    details: {
      receiptId: id,
      receiptNumber: receipt.receiptNumber,
      amount: existingPayment.amount,
    },
  });

  if (existingPayment.createdById && existingPayment.createdById !== actor.id) {
    sendNotification({
      userId: existingPayment.createdById,
      title: 'Payment Approved',
      message: `Your payment of ৳${existingPayment.amount} on Receipt ${receipt.receiptNumber} was approved by ${actor.name}.`,
      type: NotificationType.SUCCESS,
      link: `/receipts/${id}`,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Payment approved successfully',
    data: { payment: updatedPayment, receipt: updatedReceipt },
  });
});

/**
 * Update receipt status (Admin/Superadmin only: Approve or Reject)
 */
const updateReceiptStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { status } = req.body;

  const receipt = await prisma.receipt.findUnique({
    where: { id },
  });

  if (!receipt || receipt.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Receipt not found or is deleted');
  }

  const updatedReceipt = await prisma.receipt.update({
    where: { id },
    data: {
      status,
      updatedById: actor.id,
    },
    include: {
      customer: true,
      items: {
        include: {
          product: {
            select: { id: true, name: true, stock: true, unit: true },
          },
        },
      },
      payments: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  logActivity({
    userId: actor.id,
    action: status === ReceiptStatus.APPROVED ? 'APPROVE_RECEIPT' : 'REJECT_RECEIPT',
    entityType: 'RECEIPT',
    entityId: id,
    req,
    details: {
      receiptNumber: receipt.receiptNumber,
      oldStatus: receipt.status,
      newStatus: status,
    },
  });

  if (receipt.createdById && receipt.createdById !== actor.id) {
    sendNotification({
      userId: receipt.createdById,
      title: `Receipt ${status}`,
      message: `Receipt ${receipt.receiptNumber} has been ${status.toLowerCase()} by admin.`,
      type: status === ReceiptStatus.APPROVED ? NotificationType.SUCCESS : NotificationType.WARNING,
      link: `/receipts/${id}`,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: `Receipt status updated to ${status}`,
    data: updatedReceipt,
  });
});

export const ReceiptServices = {
  createReceipt,
  getAllReceipts,
  getReceiptById,
  updateReceipt,
  updateReceiptStatus,
  deleteReceipt,
  confirmDeleteReceipt,
  rejectDeleteReceipt,
  restoreReceipt,
  addPayment,
  updatePayment,
  deletePayment,
  approvePayment,
};
