import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../errors/AppError';
import {
  CustomerTransactionType,
  NotificationType,
  InvoiceStatus,
  UserRoleEnum,
} from '../../../generated/prisma/client';
import { logActivity } from '../../utils/activityLog';
import { notifyAdmins, sendNotification } from '../../utils/notification';
import { invoiceSearchableFields } from './invoice.constant';
import {
  applyStockDeltaMap,
  areInvoiceItemsChanged,
  calculateInvoiceTotals,
  deductStockForProductItems,
  generateInvoiceNumber,
  getInvoiceItemsUniquenessError,
  restoreStockForProductItems,
  roundToTwo,
} from './invoice.utils';
import { parsePhoneInput, getPhoneLookupVariants } from '../../utils/phone';
import {
  deriveMoneyForReturnInvoice,
  withDerivedReturnMoney,
} from '../ReturnInvoice/returnInvoice.utils';

/**
 * Create a new invoice with automatic pricing, per-item percentage discount,
 * overall invoice discount, payment tracking, and safe inventory deduction.
 */
const createInvoice = catchAsync(async (req, res) => {
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
          source: 'AUTO_INVOICE_CREATION',
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
          source: 'AUTO_INVOICE_CREATION',
        },
      });
    }
  }

  if (!customer) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Valid customerId or customerPhone is required');
  }

  const duplicateProductError = getInvoiceItemsUniquenessError(items);
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
  } = calculateInvoiceTotals(enrichedItems, discount, paidAmount);

  // 5. Execute transaction for Invoice, Items, Payment, and Stock updates
  const warnings: string[] = [];

  const result = await prisma.$transaction(async tx => {
    // Generate unique invoice number
    const invoiceNumber = await generateInvoiceNumber(tx);

    // Deduct inventory stock (aggregated by productId; may go negative on oversell)
    await deductStockForProductItems(tx, calculatedItems, warnings);

    // Create Invoice header
    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        customerId: customer.id,
        subTotal,
        discount: totalDiscount,
        totalAmount,
        paidAmount: finalPaidAmount,
        dueAmount,
        status: InvoiceStatus.PENDING,
        note: note || null,
        createdById: actor.id,
        updatedById: actor.id,
      },
    });

    // Create Invoice Items
    await tx.invoiceItem.createMany({
      data: calculatedItems.map(item => ({
        invoiceId: invoice.id,
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

    // Create CustomerTransaction for Invoice
    await tx.customerTransaction.create({
      data: {
        customerId: customer.id,
        type: CustomerTransactionType.INVOICE,
        invoiceId: invoice.id,
        note: note || null,
        createdById: actor.id,
      },
    });

    // If initial payment was made, record it as the first payment entry and create CustomerTransaction for Payment
    if (finalPaidAmount > 0) {
      const initialPayment = await tx.invoicePayment.create({
        data: {
          invoiceId: invoice.id,
          amount: finalPaidAmount,
          note: 'Initial payment upon invoice creation',
          createdById: actor.id,
        },
      });

      await tx.customerTransaction.create({
        data: {
          customerId: customer.id,
          type: CustomerTransactionType.PAYMENT,
          invoiceId: invoice.id,
          paymentId: initialPayment.id,
          note: initialPayment.note || null,
          createdById: actor.id,
        },
      });
    }

    // Return complete invoice
    return tx.invoice.findUnique({
      where: { id: invoice.id },
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
    action: 'CREATE_INVOICE',
    entityType: 'INVOICE',
    entityId: result?.id,
    req,
    details: {
      invoiceNumber: result?.invoiceNumber,
      totalAmount,
      paidAmount: finalPaidAmount,
      dueAmount,
      customerId: customer.id,
      itemCount: calculatedItems.length,
      warningsCount: warnings.length,
    },
  });

  notifyAdmins({
    title: 'New Invoice Created',
    message: `Invoice ${result?.invoiceNumber} created for ${customer.name} (৳${totalAmount}).`,
    type: NotificationType.INFO,
    link: `/invoices/${result?.id}`,
    req,
  });

  sendNotification({
    userId: actor.id,
    title: 'Invoice Created',
    message: `Invoice ${result?.invoiceNumber} has been generated successfully.`,
    type: NotificationType.SUCCESS,
    link: `/invoices/${result?.id}`,
    req,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Invoice created successfully',
    data: {
      invoice: result,
      warnings,
    },
  });
});

/**
 * Get all invoices with searching, filtering, and role awareness
 */
const getAllInvoices = catchAsync(async (req, res) => {
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

  const invoicesQuery = new QueryBuilder<typeof prisma.invoice>(
    prisma.invoice,
    query,
  );

  const result = await invoicesQuery
    .search(invoiceSearchableFields)
    .filter()
    .sort()
    .customFields({
      id: true,
      invoiceNumber: true,
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
    message: 'Invoices retrieved successfully',
    ...result,
  });
});

/**
 * Get a single invoice by ID with full item details and payment history
 */
const getInvoiceById = catchAsync(async (req, res) => {
  const { id } = req.params;

  const invoice = await prisma.invoice.findUnique({
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

  if (!invoice) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found');
  }

  const returnedQtyMap = new Map<string, number>();
  for (const ret of invoice.returnInvoices) {
    for (const item of ret.items) {
      returnedQtyMap.set(
        item.invoiceItemId,
        roundToTwo((returnedQtyMap.get(item.invoiceItemId) || 0) + item.quantity),
      );
    }
  }

  const itemsWithReturnMeta = invoice.items.map(it => {
    const alreadyReturned = returnedQtyMap.get(it.id) || 0;
    return {
      ...it,
      alreadyReturned,
      remainingReturnable: roundToTwo(Math.max(0, it.quantity - alreadyReturned)),
    };
  });

  const moneyCache = new Map();
  const returnInvoicesWithMoney = [];
  for (const ret of invoice.returnInvoices) {
    const money = await deriveMoneyForReturnInvoice(prisma, ret.id, moneyCache);
    returnInvoicesWithMoney.push(withDerivedReturnMoney(ret, money));
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Invoice retrieved successfully',
    data: {
      ...invoice,
      items: itemsWithReturnMeta,
      returnInvoices: returnInvoicesWithMoney,
    },
  });
});

/**
 * Update invoice with Role-Based Guard (Approved locked for cashier)
 * and differential stock synchronization.
 */
const updateInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const payload = req.body;

  const existing = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!existing || existing.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  // 1. Role-Based Guard: Cashiers CANNOT edit an APPROVED invoice
  if (existing.status === InvoiceStatus.APPROVED && actor.role === UserRoleEnum.CASHIER) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Approved invoices are locked and cannot be edited by cashiers. Please contact an administrator.',
    );
  }

  const itemsChanged =
    payload.items && Array.isArray(payload.items)
      ? areInvoiceItemsChanged(existing.items, payload.items)
      : false;

  if (itemsChanged) {
    const activeReturnCount = await prisma.returnInvoice.count({
      where: { invoiceId: id, isDeleted: false },
    });
    if (activeReturnCount > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Cannot change invoice items while return invoices exist for this invoice. Delete or adjust returns first.',
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
          source: 'AUTO_INVOICE_UPDATE',
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
          source: 'AUTO_INVOICE_UPDATE',
        },
      });
    }

    customerIdToUpdate = cust.id;
  }

  if (payload.items && Array.isArray(payload.items)) {
    const duplicateProductError = getInvoiceItemsUniquenessError(payload.items);
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
      const totals = calculateInvoiceTotals(payload.items, finalDiscount, existing.paidAmount);
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

      // Clean up any orphaned return invoice items belonging to deleted return invoices for this invoice
      await tx.returnInvoiceItem.deleteMany({
        where: { invoiceId: id },
      });

      // Delete old items and insert updated items
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceItem.createMany({
        data: totals.calculatedItems.map(item => ({
          invoiceId: id,
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
      const totals = calculateInvoiceTotals(
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

    // 3. Update invoice record
    const updatedInvoice = await tx.invoice.update({
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

    return updatedInvoice;
  });

  logActivity({
    userId: actor.id,
    action: 'UPDATE_INVOICE',
    entityType: 'INVOICE',
    entityId: id,
    req,
    details: {
      invoiceNumber: updatedResult.invoiceNumber,
      totalAmount: updatedResult.totalAmount,
      dueAmount: updatedResult.dueAmount,
      warningsCount: warnings.length,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Invoice updated successfully',
    data: {
      invoice: updatedResult,
      warnings,
    },
  });
});

/**
 * Delete invoice handler:
 * - Admin/Superadmin: Immediate soft-delete and automatically restores inventory stock.
 * - Cashier: Submits delete request (isDeleteRequested: true) and notifies admins.
 */
const deleteInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { reason } = req.body || {};

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found');
  }

  const activeReturnCount = await prisma.returnInvoice.count({
    where: { invoiceId: id, isDeleted: false },
  });
  if (activeReturnCount > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot delete this invoice while return invoices exist. Delete the return invoices first.',
    );
  }

  const isAdmin = actor.role === UserRoleEnum.SUPERADMIN || actor.role === UserRoleEnum.ADMIN;

  if (isAdmin) {
    // Immediate soft delete by Admin with inventory restoration
    const result = await prisma.$transaction(async tx => {
      await restoreStockForProductItems(tx, invoice.items, []);

      return tx.invoice.update({
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
      action: 'ADMIN_DELETE_INVOICE',
      entityType: 'INVOICE',
      entityId: id,
      req,
      details: { invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount },
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Invoice deleted successfully and product inventory has been restored',
      data: result,
    });
  } else {
    // Cashier delete request -> Pending Admin Confirmation
    if (invoice.isDeleteRequested) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Deletion request is already pending admin confirmation',
      );
    }

    const result = await prisma.invoice.update({
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
      action: 'REQUEST_DELETE_INVOICE',
      entityType: 'INVOICE',
      entityId: id,
      req,
      details: { invoiceNumber: invoice.invoiceNumber, reason },
    });

    notifyAdmins({
      title: 'Invoice Deletion Requested',
      message: `${actor.name || 'Cashier'} requested deletion of Invoice ${invoice.invoiceNumber}.`,
      type: NotificationType.WARNING,
      link: `/invoices/${id}`,
      req,
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Invoice deletion request submitted to admin for confirmation',
      data: result,
    });
  }
});

/**
 * Confirm delete request (Admin only) and restore inventory stock
 */
const confirmDeleteInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found');
  }

  const activeReturnCount = await prisma.returnInvoice.count({
    where: { invoiceId: id, isDeleted: false },
  });
  if (activeReturnCount > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot delete this invoice while return invoices exist. Delete the return invoices first.',
    );
  }

  const result = await prisma.$transaction(async tx => {
    await restoreStockForProductItems(tx, invoice.items, []);

    return tx.invoice.update({
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
    action: 'ADMIN_CONFIRM_DELETE_INVOICE',
    entityType: 'INVOICE',
    entityId: id,
    req,
    details: { invoiceNumber: invoice.invoiceNumber },
  });

  if (invoice.deleteRequestedById) {
    sendNotification({
      userId: invoice.deleteRequestedById,
      title: 'Invoice Deletion Confirmed',
      message: `Admin confirmed deletion for Invoice ${invoice.invoiceNumber}.`,
      type: NotificationType.SUCCESS,
      link: `/invoices`,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Invoice deletion confirmed and inventory stock restored',
    data: result,
  });
});

/**
 * Reject delete request (Admin only)
 */
const rejectDeleteInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found');
  }

  const result = await prisma.invoice.update({
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
    action: 'ADMIN_REJECT_DELETE_INVOICE',
    entityType: 'INVOICE',
    entityId: id,
    req,
    details: { invoiceNumber: invoice.invoiceNumber },
  });

  if (invoice.deleteRequestedById) {
    sendNotification({
      userId: invoice.deleteRequestedById,
      title: 'Invoice Deletion Rejected',
      message: `Admin rejected deletion request for Invoice ${invoice.invoiceNumber}.`,
      type: NotificationType.WARNING,
      link: `/invoices/${id}`,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Invoice deletion request rejected',
    data: result,
  });
});

/**
 * Restore / Undo soft-deleted invoice (Admin only) and re-deduct inventory
 */
const restoreInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!invoice || !invoice.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invoice is not in deleted state');
  }

  const warnings: string[] = [];

  const result = await prisma.$transaction(async tx => {
    await deductStockForProductItems(tx, invoice.items, warnings);

    return tx.invoice.update({
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
    action: 'ADMIN_RESTORE_INVOICE',
    entityType: 'INVOICE',
    entityId: id,
    req,
    details: { invoiceNumber: invoice.invoiceNumber },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Invoice restored successfully',
    data: {
      invoice: result,
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

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  if (invoice.dueAmount <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'This invoice is already fully paid');
  }

  const paymentAmount = roundToTwo(amount);

  if (paymentAmount > invoice.dueAmount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Payment amount (৳${paymentAmount}) exceeds remaining due amount (৳${invoice.dueAmount})`,
    );
  }

  const result = await prisma.$transaction(async tx => {
    // 1. Create InvoicePayment entry with timestamp
    const payment = await tx.invoicePayment.create({
      data: {
        invoiceId: id,
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
        customerId: invoice.customerId,
        type: CustomerTransactionType.PAYMENT,
        invoiceId: invoice.id,
        paymentId: payment.id,
        note: note || null,
        createdById: actor.id,
        createdAt: date ? new Date(date) : undefined,
      },
    });

    // 2. Update Invoice totals
    const newPaidAmount = roundToTwo(invoice.paidAmount + paymentAmount);
    const newDueAmount = roundToTwo(Math.max(0, invoice.totalAmount - newPaidAmount));

    const updatedInvoice = await tx.invoice.update({
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

    return { payment, invoice: updatedInvoice };
  });

  logActivity({
    userId: actor.id,
    action: 'ADD_INVOICE_PAYMENT',
    entityType: 'INVOICE_PAYMENT',
    entityId: result.payment.id,
    req,
    details: {
      invoiceId: id,
      invoiceNumber: invoice.invoiceNumber,
      amount: paymentAmount,
      remainingDue: result.invoice.dueAmount,
    },
  });

  sendNotification({
    userId: actor.id,
    title: 'Payment Received',
    message: `Payment of ৳${paymentAmount} recorded for Invoice ${invoice.invoiceNumber}. Remaining due: ৳${result.invoice.dueAmount}.`,
    type: NotificationType.SUCCESS,
    link: `/invoices/${id}`,
    req,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Payment recorded successfully',
    data: result,
  });
});

/**
 * Update an existing payment on an invoice
 */
const updatePayment = catchAsync(async (req, res) => {
  const { id, paymentId } = req.params;
  const actor = req.user;
  const { amount, note, date } = req.body;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  const existingPayment = await prisma.invoicePayment.findUnique({
    where: { id: paymentId },
  });

  if (!existingPayment || existingPayment.invoiceId !== id) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment record not found for this invoice');
  }

  if (existingPayment.status === InvoiceStatus.APPROVED) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Approved payments cannot be edited');
  }

  const newAmount = amount !== undefined ? roundToTwo(amount) : existingPayment.amount;
  const diff = roundToTwo(newAmount - existingPayment.amount);

  if (diff > invoice.dueAmount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Payment increase of ৳${diff} exceeds remaining due amount (৳${invoice.dueAmount})`,
    );
  }

  const result = await prisma.$transaction(async tx => {
    // 1. Update InvoicePayment
    const updatedPayment = await tx.invoicePayment.update({
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

    // 2. Update Invoice totals
    const newPaidAmount = roundToTwo(invoice.paidAmount + diff);
    const newDueAmount = roundToTwo(Math.max(0, invoice.totalAmount - newPaidAmount));

    const updatedInvoice = await tx.invoice.update({
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

    return { payment: updatedPayment, invoice: updatedInvoice };
  });

  logActivity({
    userId: actor.id,
    action: 'UPDATE_INVOICE_PAYMENT',
    entityType: 'INVOICE_PAYMENT',
    entityId: paymentId,
    req,
    details: {
      invoiceId: id,
      invoiceNumber: invoice.invoiceNumber,
      oldAmount: existingPayment.amount,
      newAmount,
      diff,
      remainingDue: result.invoice.dueAmount,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Payment updated successfully',
    data: result,
  });
});

/**
 * Delete an existing payment on an invoice and restore due amount
 */
const deletePayment = catchAsync(async (req, res) => {
  const { id, paymentId } = req.params;
  const actor = req.user;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  const existingPayment = await prisma.invoicePayment.findUnique({
    where: { id: paymentId },
  });

  if (!existingPayment || existingPayment.invoiceId !== id) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment record not found for this invoice');
  }

  if (existingPayment.status === InvoiceStatus.APPROVED) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Approved payments cannot be deleted');
  }

  const result = await prisma.$transaction(async tx => {
    // 1. Delete payment
    await tx.invoicePayment.delete({
      where: { id: paymentId },
    });

    // Delete associated customer transaction
    await tx.customerTransaction.deleteMany({
      where: { paymentId },
    });

    // 2. Revert paid and due amounts
    const newPaidAmount = roundToTwo(Math.max(0, invoice.paidAmount - existingPayment.amount));
    const newDueAmount = roundToTwo(Math.max(0, invoice.totalAmount - newPaidAmount));

    const updatedInvoice = await tx.invoice.update({
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

    return { deletedPaymentId: paymentId, invoice: updatedInvoice };
  });

  logActivity({
    userId: actor.id,
    action: 'DELETE_INVOICE_PAYMENT',
    entityType: 'INVOICE_PAYMENT',
    entityId: paymentId,
    req,
    details: {
      invoiceId: id,
      invoiceNumber: invoice.invoiceNumber,
      amount: existingPayment.amount,
      remainingDue: result.invoice.dueAmount,
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

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  const existingPayment = await prisma.invoicePayment.findUnique({
    where: { id: paymentId },
  });

  if (!existingPayment || existingPayment.invoiceId !== id) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment record not found for this invoice');
  }

  if (existingPayment.status === InvoiceStatus.APPROVED) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Payment is already approved');
  }

  const updatedPayment = await prisma.invoicePayment.update({
    where: { id: paymentId },
    data: {
      status: InvoiceStatus.APPROVED,
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

  const updatedInvoice = await prisma.invoice.findUnique({
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
    action: 'APPROVE_INVOICE_PAYMENT',
    entityType: 'INVOICE_PAYMENT',
    entityId: paymentId,
    req,
    details: {
      invoiceId: id,
      invoiceNumber: invoice.invoiceNumber,
      amount: existingPayment.amount,
    },
  });

  if (existingPayment.createdById && existingPayment.createdById !== actor.id) {
    sendNotification({
      userId: existingPayment.createdById,
      title: 'Payment Approved',
      message: `Your payment of ৳${existingPayment.amount} on Invoice ${invoice.invoiceNumber} was approved by ${actor.name}.`,
      type: NotificationType.SUCCESS,
      link: `/invoices/${id}`,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Payment approved successfully',
    data: { payment: updatedPayment, invoice: updatedInvoice },
  });
});

/**
 * Update invoice status (Admin/Superadmin only: Approve or Reject)
 */
const updateInvoiceStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { status } = req.body;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  const updatedInvoice = await prisma.invoice.update({
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
    action: status === InvoiceStatus.APPROVED ? 'APPROVE_INVOICE' : 'REJECT_INVOICE',
    entityType: 'INVOICE',
    entityId: id,
    req,
    details: {
      invoiceNumber: invoice.invoiceNumber,
      oldStatus: invoice.status,
      newStatus: status,
    },
  });

  if (invoice.createdById && invoice.createdById !== actor.id) {
    sendNotification({
      userId: invoice.createdById,
      title: `Invoice ${status}`,
      message: `Invoice ${invoice.invoiceNumber} has been ${status.toLowerCase()} by admin.`,
      type: status === InvoiceStatus.APPROVED ? NotificationType.SUCCESS : NotificationType.WARNING,
      link: `/invoices/${id}`,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: `Invoice status updated to ${status}`,
    data: updatedInvoice,
  });
});

export const InvoiceServices = {
  createInvoice,
  getAllInvoices,
  getInvoiceById,
  updateInvoice,
  updateInvoiceStatus,
  deleteInvoice,
  confirmDeleteInvoice,
  rejectDeleteInvoice,
  restoreInvoice,
  addPayment,
  updatePayment,
  deletePayment,
  approvePayment,
};
