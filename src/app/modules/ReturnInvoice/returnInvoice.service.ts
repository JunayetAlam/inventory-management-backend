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
import {
  applyStockDeltaMap,
  deductStockForProductItems,
  restoreStockForProductItems,
  roundToTwo,
} from '../Invoice/invoice.utils';
import { returnInvoiceSearchableFields } from './returnInvoice.constant';
import {
  deriveMoneyForReturnInvoice,
  deriveInvoiceSettlement,
  deriveReturnMoney,
  generateReturnNumber,
  getLatestActiveReturn,
  getRefundOverCapMessage,
  getReturnItemsUniquenessError,
  getReturnedQtyMap,
  hasNewerActiveReturn,
  isLatestActiveReturn,
  sumActiveReturnMoneyOnInvoice,
  sumAncestorReturnMoney,
  withDerivedReturnMoney,
} from './returnInvoice.utils';

const previousReturnInclude = {
  select: {
    id: true,
    returnNumber: true,
    discount: true,
    refundedAmount: true,
    createdAt: true,
    items: {
      select: {
        sellingPrice: true,
        quantity: true,
        discounts: true,
        totalPrice: true,
      },
    },
  },
} as const;

const returnInvoiceInclude = {
  invoice: {
    select: {
      id: true,
      invoiceNumber: true,
      customerId: true,
      totalAmount: true,
      paidAmount: true,
      dueAmount: true,
      customer: {
        select: {
          id: true,
          name: true,
          countryCode: true,
          phoneNumber: true,
          email: true,
          address: true,
        },
      },
    },
  },
  previousReturnInvoice: previousReturnInclude,
  items: {
    include: {
      product: {
        select: { id: true, name: true, stock: true, unit: true },
      },
      invoiceItem: {
        select: {
          id: true,
          productName: true,
          quantity: true,
          sellingPrice: true,
          discounts: true,
          unit: true,
        },
      },
    },
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
} as const;

type ReturnPayloadItem = {
  invoiceItemId: string;
  quantity: number;
  sellingPrice?: number;
  discounts?: number[];
  discount?: number;
};

const enrichReturnItemsFromInvoice = async (
  invoiceId: string,
  items: ReturnPayloadItem[],
  excludeReturnInvoiceId?: string,
) => {
  const uniquenessError = getReturnItemsUniquenessError(items);
  if (uniquenessError) {
    throw new AppError(httpStatus.BAD_REQUEST, uniquenessError);
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { items: true },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Source invoice not found or is deleted');
  }

  const invoiceItemMap = new Map(invoice.items.map(it => [it.id, it]));
  const returnedMap = await getReturnedQtyMap(prisma, invoiceId, excludeReturnInvoiceId);

  const enriched = items.map(it => {
    const source = invoiceItemMap.get(it.invoiceItemId);
    if (!source) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Invoice item ${it.invoiceItemId} does not belong to the selected invoice`,
      );
    }

    const alreadyReturned = returnedMap.get(source.id) || 0;
    const remaining = roundToTwo(source.quantity - alreadyReturned);

    if (remaining <= 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Product "${source.productName}" has no remaining returnable quantity`,
      );
    }

    if (it.quantity > remaining) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Return quantity for "${source.productName}" cannot exceed remaining ${remaining}`,
      );
    }

    return {
      invoiceItemId: source.id,
      invoiceId: invoice.id,
      productId: source.productId,
      productName: source.productName,
      unit: source.unit,
      sellingPrice: it.sellingPrice ?? source.sellingPrice,
      quantity: it.quantity,
      discounts: it.discounts ?? (it.discount !== undefined ? [it.discount] : source.discounts),
    };
  });

  return { invoice, enriched };
};

const assertLatestForMutation = async (
  returnInvoice: { id: string; invoiceId: string; isDeleted?: boolean },
  action: 'edited' | 'deleted',
) => {
  const latest = await isLatestActiveReturn(prisma, returnInvoice);
  if (!latest) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Only the latest return invoice on this invoice can be ${action}`,
    );
  }
};

const hydrateReturnInvoice = async <
  T extends {
    id: string;
    previousReturnInvoiceId?: string | null;
    invoice?: {
      totalAmount?: number;
      paidAmount?: number;
    } | null;
  },
>(
  invoice: T,
) => {
  const cache = new Map();
  const money = await deriveMoneyForReturnInvoice(prisma, invoice.id, cache);
  const hydrated = withDerivedReturnMoney(invoice, money);

  const prev = (invoice as any).previousReturnInvoice;
  if (prev?.id) {
    const prevMoney = await deriveMoneyForReturnInvoice(prisma, prev.id, cache);
    (hydrated as any).previousReturnInvoice = withDerivedReturnMoney(prev, prevMoney);
  }

  const ancestorMoney = await sumAncestorReturnMoney(
    prisma,
    invoice.previousReturnInvoiceId,
    cache,
  );
  // Position before this return (ancestors only) — UI shows only due/refundable
  const beforeThis = deriveInvoiceSettlement({
    invoiceTotal: invoice.invoice?.totalAmount ?? 0,
    paidAmount: invoice.invoice?.paidAmount ?? 0,
    creditsBefore: ancestorMoney.credits,
    thisCredit: 0,
    refundedBefore: ancestorMoney.refunded,
    thisRefunded: 0,
  });
  const afterThis = deriveInvoiceSettlement({
    invoiceTotal: invoice.invoice?.totalAmount ?? 0,
    paidAmount: invoice.invoice?.paidAmount ?? 0,
    creditsBefore: ancestorMoney.credits,
    thisCredit: money.totalAmount,
    refundedBefore: ancestorMoney.refunded,
    thisRefunded: money.refundedAmount,
  });

  return {
    ...hydrated,
    previousPosition: {
      netDue: beforeThis.netDue,
      netRefundable: beforeThis.netRefundable,
    },
    currentPosition: {
      netDue: afterThis.netDue,
      netRefundable: afterThis.netRefundable,
    },
  };
};

const hydrateReturnInvoiceList = async <T extends { id: string; invoiceId: string; createdAt: Date; isDeleted: boolean }>(
  rows: T[],
) => {
  if (!rows.length) return [];

  const cache = new Map();
  const invoiceIds = [...new Set(rows.map(r => r.invoiceId))];

  const latestByInvoice = new Map<string, string>();
  await Promise.all(
    invoiceIds.map(async invoiceId => {
      const latest = await getLatestActiveReturn(prisma, invoiceId, { select: { id: true } });
      if (latest) latestByInvoice.set(invoiceId, latest.id);
    }),
  );

  const result = [];
  for (const row of rows) {
    const money = await deriveMoneyForReturnInvoice(prisma, row.id, cache);
    const isLatest = !row.isDeleted && latestByInvoice.get(row.invoiceId) === row.id;
    const canRestore =
      row.isDeleted && !(await hasNewerActiveReturn(prisma, row));

    result.push({
      ...withDerivedReturnMoney(row, money),
      isLatest,
      canRestore,
    });
  }
  return result;
};

/**
 * Create a return invoice under a source invoice. Restores product stock.
 * Money fields are derived from product lines + previous tip due (not persisted).
 */
const createReturnInvoice = catchAsync(async (req, res) => {
  const actor = req.user;
  const {
    invoiceId,
    items,
    discount = 0,
    note,
  } = req.body;
  const refundedAmountInput = req.body.refundedAmount;

  const { invoice, enriched } = await enrichReturnItemsFromInvoice(invoiceId, items);

  const previous = await getLatestActiveReturn(prisma, invoiceId, {
    include: {
      items: {
        select: {
          sellingPrice: true,
          quantity: true,
          discounts: true,
          totalPrice: true,
        },
      },
    },
  });

  let previousDueAmount = 0;
  if (previous) {
    const prevMoney = await deriveMoneyForReturnInvoice(prisma, previous.id);
    previousDueAmount = prevMoney.dueRefundAmount;
  }

  const creditPreview = deriveReturnMoney(enriched, discount, 0, previousDueAmount);
  const finalRefunded =
    refundedAmountInput !== undefined && refundedAmountInput !== null
      ? roundToTwo(Number(refundedAmountInput))
      : creditPreview.totalAmount;

  const overCap = getRefundOverCapMessage(
    previousDueAmount,
    creditPreview.totalAmount,
    finalRefunded,
  );
  if (overCap) {
    throw new AppError(httpStatus.BAD_REQUEST, overCap);
  }

  const {
    calculatedItems,
    discount: totalDiscount,
    totalAmount,
    refundedAmount: settledRefunded,
    dueRefundAmount,
    subTotal,
    previousDueAmount: settledPreviousDue,
  } = deriveReturnMoney(enriched, discount, finalRefunded, previousDueAmount);

  const result = await prisma.$transaction(async tx => {
    const returnNumber = await generateReturnNumber(tx);

    await restoreStockForProductItems(tx, calculatedItems, []);

    const returnInvoice = await tx.returnInvoice.create({
      data: {
        returnNumber,
        invoiceId: invoice.id,
        previousReturnInvoiceId: previous?.id || null,
        discount: totalDiscount,
        refundedAmount: settledRefunded,
        status: InvoiceStatus.PENDING,
        note: note || null,
        createdById: actor.id,
        updatedById: actor.id,
      },
    });

    await tx.returnInvoiceItem.createMany({
      data: calculatedItems.map(item => ({
        returnInvoiceId: returnInvoice.id,
        invoiceId: item.invoiceId,
        invoiceItemId: item.invoiceItemId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        sellingPrice: item.sellingPrice,
        quantity: item.quantity,
        discounts: item.discounts,
        totalPrice: item.totalPrice,
      })),
    });

    // Create CustomerTransaction for Return Invoice
    await tx.customerTransaction.create({
      data: {
        customerId: invoice.customerId,
        type: CustomerTransactionType.RETURN_INVOICE,
        invoiceId: invoice.id,
        returnInvoiceId: returnInvoice.id,
        note: note || null,
        createdById: actor.id,
      },
    });

    return tx.returnInvoice.findUnique({
      where: { id: returnInvoice.id },
      include: returnInvoiceInclude,
    });
  });

  const hydrated = result ? await hydrateReturnInvoice(result) : null;

  logActivity({
    userId: actor.id,
    action: 'CREATE_RETURN_INVOICE',
    entityType: 'RETURN_INVOICE',
    entityId: result?.id,
    req,
    details: {
      returnNumber: result?.returnNumber,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount,
      previousDueAmount: settledPreviousDue,
      dueRefundAmount,
      previousReturnInvoiceId: previous?.id || null,
      itemCount: calculatedItems.length,
    },
  });

  notifyAdmins({
    title: 'Return Invoice Created',
    message: `Return ${result?.returnNumber} created against Invoice ${invoice.invoiceNumber} (৳${totalAmount}).`,
    type: NotificationType.INFO,
    link: `/return-invoices/${result?.id}`,
    req,
  });

  sendNotification({
    userId: actor.id,
    title: 'Return Invoice Created',
    message: `Return ${result?.returnNumber} has been generated successfully.`,
    type: NotificationType.SUCCESS,
    link: `/return-invoices/${result?.id}`,
    req,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Return invoice created successfully',
    data: {
      returnInvoice: hydrated
        ? { ...hydrated, isLatest: true, canRestore: false }
        : null,
    },
  });
});

const getAllReturnInvoices = catchAsync(async (req, res) => {
  const actor = req.user;
  const query: Record<string, unknown> = { ...req.query };

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

  const returnsQuery = new QueryBuilder<typeof prisma.returnInvoice>(
    prisma.returnInvoice,
    query,
  );

  const result = await returnsQuery
    .search(returnInvoiceSearchableFields)
    .filter()
    .sort()
    .customFields({
      id: true,
      returnNumber: true,
      invoiceId: true,
      previousReturnInvoiceId: true,
      discount: true,
      refundedAmount: true,
      status: true,
      note: true,
      isDeleted: true,
      isDeleteRequested: true,
      deleteRequestedAt: true,
      deleteReason: true,
      createdAt: true,
      updatedAt: true,
      items: {
        select: {
          sellingPrice: true,
          quantity: true,
          discounts: true,
          totalPrice: true,
        },
      },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          customer: {
            select: {
              id: true,
              name: true,
              countryCode: true,
              phoneNumber: true,
            },
          },
        },
      },
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      updatedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      deleteRequestedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      _count: {
        select: { items: true },
      },
    })
    .paginate()
    .execute();

  const data = await hydrateReturnInvoiceList(result.data || []);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Return invoices retrieved successfully',
    ...result,
    data,
  });
});

const getReturnInvoiceById = catchAsync(async (req, res) => {
  const { id } = req.params;

  const returnInvoice = await prisma.returnInvoice.findUnique({
    where: { id },
    include: returnInvoiceInclude,
  });

  if (!returnInvoice) {
    throw new AppError(httpStatus.NOT_FOUND, 'Return invoice not found');
  }

  const hydrated = await hydrateReturnInvoice(returnInvoice);
  const isLatest = await isLatestActiveReturn(prisma, returnInvoice);
  const canRestore =
    returnInvoice.isDeleted && !(await hasNewerActiveReturn(prisma, returnInvoice));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Return invoice retrieved successfully',
    data: {
      ...hydrated,
      isLatest,
      canRestore,
    },
  });
});

/**
 * Returnable lines for an invoice + previous (latest active) return money summary.
 */
const getReturnableItemsByInvoice = catchAsync(async (req, res) => {
  const { invoiceId } = req.params;
  const excludeReturnInvoiceId =
    typeof req.query.excludeReturnInvoiceId === 'string'
      ? req.query.excludeReturnInvoiceId
      : undefined;

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: {
        include: {
          product: {
            select: { id: true, name: true, stock: true, unit: true },
          },
        },
      },
      customer: {
        select: {
          id: true,
          name: true,
          countryCode: true,
          phoneNumber: true,
        },
      },
    },
  });

  if (!invoice || invoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Invoice not found or is deleted');
  }

  const returnedMap = await getReturnedQtyMap(
    prisma,
    invoiceId,
    excludeReturnInvoiceId,
  );

  const items = invoice.items.map(it => {
    const alreadyReturned = returnedMap.get(it.id) || 0;
    const remainingReturnable = roundToTwo(Math.max(0, it.quantity - alreadyReturned));
    return {
      invoiceItemId: it.id,
      productId: it.productId,
      productName: it.productName,
      unit: it.unit,
      sellingPrice: it.sellingPrice,
      discounts: it.discounts,
      originalQuantity: it.quantity,
      alreadyReturned,
      remainingReturnable,
      product: it.product,
    };
  });

  // When editing, previous tip is the latest active excluding the invoice being edited
  let previousReturn = null as null | Record<string, unknown>;
  const latestActive = await getLatestActiveReturn(prisma, invoiceId, {
    include: {
      items: {
        select: {
          sellingPrice: true,
          quantity: true,
          discounts: true,
          totalPrice: true,
        },
      },
    },
  });

  if (latestActive && latestActive.id !== excludeReturnInvoiceId) {
    const money = await deriveMoneyForReturnInvoice(prisma, latestActive.id);
    previousReturn = {
      id: latestActive.id,
      returnNumber: latestActive.returnNumber,
      ...money,
      createdAt: latestActive.createdAt,
    };
  } else if (excludeReturnInvoiceId) {
    // Editing the tip: show that invoice's linked previous as context
    const editing = await prisma.returnInvoice.findUnique({
      where: { id: excludeReturnInvoiceId },
      select: { previousReturnInvoiceId: true },
    });
    if (editing?.previousReturnInvoiceId) {
      const prev = await prisma.returnInvoice.findUnique({
        where: { id: editing.previousReturnInvoiceId },
        include: {
          items: {
            select: {
              sellingPrice: true,
              quantity: true,
              discounts: true,
              totalPrice: true,
            },
          },
        },
      });
      if (prev) {
        const money = await deriveMoneyForReturnInvoice(prisma, prev.id);
        previousReturn = {
          id: prev.id,
          returnNumber: prev.returnNumber,
          ...money,
          createdAt: prev.createdAt,
        };
      }
    }
  }

  const priorMoney = await sumActiveReturnMoneyOnInvoice(
    prisma,
    invoiceId,
    excludeReturnInvoiceId,
  );
  const beforeThis = deriveInvoiceSettlement({
    invoiceTotal: invoice.totalAmount,
    paidAmount: invoice.paidAmount,
    creditsBefore: priorMoney.credits,
    thisCredit: 0,
    refundedBefore: priorMoney.refunded,
    thisRefunded: 0,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Returnable invoice items retrieved successfully',
    data: {
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customer: invoice.customer,
        totalAmount: invoice.totalAmount,
        paidAmount: invoice.paidAmount,
        dueAmount: invoice.dueAmount,
      },
      items,
      previousReturn,
      previousDueAmount: previousReturn
        ? (previousReturn.dueRefundAmount as number)
        : 0,
      previousPosition: {
        netDue: beforeThis.netDue,
        netRefundable: beforeThis.netRefundable,
      },
    },
  });
});

const updateReturnInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const payload = req.body;

  const existing = await prisma.returnInvoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!existing || existing.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Return invoice not found or is deleted');
  }

  await assertLatestForMutation(existing, 'edited');

  if (
    existing.status === InvoiceStatus.APPROVED &&
    actor.role === UserRoleEnum.CASHIER
  ) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Approved return invoices are locked and cannot be edited by cashiers. Please contact an administrator.',
    );
  }

  let previousDueAmount = 0;
  if (existing.previousReturnInvoiceId) {
    const prevMoney = await deriveMoneyForReturnInvoice(
      prisma,
      existing.previousReturnInvoiceId,
    );
    previousDueAmount = prevMoney.dueRefundAmount;
  }

  const warnings: string[] = [];

  const updatedResult = await prisma.$transaction(async tx => {
    const finalDiscount =
      payload.discount !== undefined ? roundToTwo(payload.discount) : existing.discount;
    let finalRefunded =
      payload.refundedAmount !== undefined
        ? roundToTwo(payload.refundedAmount)
        : existing.refundedAmount;

    if (payload.items && Array.isArray(payload.items)) {
      const { enriched } = await enrichReturnItemsFromInvoice(
        existing.invoiceId,
        payload.items,
        existing.id,
      );

      const totals = deriveReturnMoney(
        enriched,
        finalDiscount,
        finalRefunded,
        previousDueAmount,
      );
      finalRefunded = totals.refundedAmount;

      const overCap = getRefundOverCapMessage(
        previousDueAmount,
        totals.totalAmount,
        finalRefunded,
      );
      if (overCap) {
        throw new AppError(httpStatus.BAD_REQUEST, overCap);
      }

      const oldQtyMap = new Map<string, number>();
      existing.items.forEach(it => {
        if (it.productId) {
          oldQtyMap.set(
            it.productId,
            roundToTwo((oldQtyMap.get(it.productId) || 0) + it.quantity),
          );
        }
      });

      const newQtyMap = new Map<string, number>();
      totals.calculatedItems.forEach(it => {
        if (it.productId) {
          newQtyMap.set(
            it.productId,
            roundToTwo((newQtyMap.get(it.productId) || 0) + it.quantity),
          );
        }
      });

      const stockDeltaMap = new Map<string, number>();
      const allProductIds = new Set([...oldQtyMap.keys(), ...newQtyMap.keys()]);
      for (const productId of allProductIds) {
        const oldQty = oldQtyMap.get(productId) || 0;
        const newQty = newQtyMap.get(productId) || 0;
        const stockDelta = roundToTwo(newQty - oldQty);
        if (stockDelta !== 0) {
          stockDeltaMap.set(productId, stockDelta);
        }
      }

      await applyStockDeltaMap(tx, stockDeltaMap, warnings);

      await tx.returnInvoiceItem.deleteMany({ where: { returnInvoiceId: id } });
      await tx.returnInvoiceItem.createMany({
        data: totals.calculatedItems.map(item => ({
          returnInvoiceId: id,
          invoiceId: item.invoiceId,
          invoiceItemId: item.invoiceItemId,
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          sellingPrice: item.sellingPrice,
          quantity: item.quantity,
          discounts: item.discounts,
          totalPrice: item.totalPrice,
        })),
      });
    } else if (payload.discount !== undefined || payload.refundedAmount !== undefined) {
      const totals = deriveReturnMoney(
        existing.items.map(it => ({
          invoiceItemId: it.invoiceItemId,
          invoiceId: it.invoiceId,
          productId: it.productId,
          productName: it.productName,
          unit: it.unit,
          sellingPrice: it.sellingPrice,
          quantity: it.quantity,
          discounts: it.discounts,
        })),
        finalDiscount,
        finalRefunded,
        previousDueAmount,
      );
      finalRefunded = totals.refundedAmount;

      const overCap = getRefundOverCapMessage(
        previousDueAmount,
        totals.totalAmount,
        finalRefunded,
      );
      if (overCap) {
        throw new AppError(httpStatus.BAD_REQUEST, overCap);
      }
    }

    const statusToSet =
      actor.role === UserRoleEnum.CASHIER
        ? undefined
        : payload.status !== undefined
          ? payload.status
          : undefined;

    if (payload.note !== undefined) {
      await tx.customerTransaction.updateMany({
        where: { returnInvoiceId: id },
        data: {
          note: payload.note || null,
        },
      });
    }

    return tx.returnInvoice.update({
      where: { id },
      data: {
        discount: finalDiscount,
        refundedAmount: finalRefunded,
        note: payload.note !== undefined ? payload.note : undefined,
        ...(statusToSet !== undefined ? { status: statusToSet } : {}),
        updatedById: actor.id,
      },
      include: returnInvoiceInclude,
    });
  });

  const hydrated = await hydrateReturnInvoice(updatedResult);

  logActivity({
    userId: actor.id,
    action: 'UPDATE_RETURN_INVOICE',
    entityType: 'RETURN_INVOICE',
    entityId: id,
    req,
    details: {
      returnNumber: existing.returnNumber,
      totalAmount: hydrated.totalAmount,
      dueRefundAmount: hydrated.dueRefundAmount,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Return invoice updated successfully',
    data: {
      returnInvoice: { ...hydrated, isLatest: true, canRestore: false },
      warnings,
    },
  });
});

const updateReturnInvoiceStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { status } = req.body;

  const existing = await prisma.returnInvoice.findUnique({ where: { id } });

  if (!existing || existing.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Return invoice not found or is deleted');
  }

  const updated = await prisma.returnInvoice.update({
    where: { id },
    data: {
      status,
      updatedById: actor.id,
    },
    include: returnInvoiceInclude,
  });

  logActivity({
    userId: actor.id,
    action: status === InvoiceStatus.APPROVED ? 'APPROVE_RETURN_INVOICE' : 'REJECT_RETURN_INVOICE',
    entityType: 'RETURN_INVOICE',
    entityId: id,
    req,
    details: {
      returnNumber: existing.returnNumber,
      oldStatus: existing.status,
      newStatus: status,
    },
  });

  if (existing.createdById && existing.createdById !== actor.id) {
    sendNotification({
      userId: existing.createdById,
      title: `Return Invoice ${status}`,
      message: `Return ${existing.returnNumber} has been ${status.toLowerCase()} by admin.`,
      type: status === InvoiceStatus.APPROVED ? NotificationType.SUCCESS : NotificationType.WARNING,
      link: `/return-invoices/${id}`,
      req,
    });
  }

  const hydrated = await hydrateReturnInvoice(updated);
  const isLatest = await isLatestActiveReturn(prisma, updated);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: `Return invoice status updated to ${status}`,
    data: { ...hydrated, isLatest, canRestore: false },
  });
});

const deleteReturnInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { reason } = req.body || {};

  const returnInvoice = await prisma.returnInvoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!returnInvoice || returnInvoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Return invoice not found');
  }

  await assertLatestForMutation(returnInvoice, 'deleted');

  const money = await deriveMoneyForReturnInvoice(prisma, returnInvoice.id);

  const isAdmin =
    actor.role === UserRoleEnum.SUPERADMIN || actor.role === UserRoleEnum.ADMIN;

  if (isAdmin) {
    const warnings: string[] = [];
    const result = await prisma.$transaction(async tx => {
      await deductStockForProductItems(tx, returnInvoice.items, warnings);
      return tx.returnInvoice.update({
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
      action: 'ADMIN_DELETE_RETURN_INVOICE',
      entityType: 'RETURN_INVOICE',
      entityId: id,
      req,
      details: {
        returnNumber: returnInvoice.returnNumber,
        totalAmount: money.totalAmount,
        dueRefundAmount: money.dueRefundAmount,
      },
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Return invoice deleted successfully and inventory has been adjusted',
      data: { returnInvoice: withDerivedReturnMoney(result, money), warnings },
    });
  } else {
    if (returnInvoice.isDeleteRequested) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Deletion request is already pending admin confirmation',
      );
    }

    const result = await prisma.returnInvoice.update({
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
      action: 'REQUEST_DELETE_RETURN_INVOICE',
      entityType: 'RETURN_INVOICE',
      entityId: id,
      req,
      details: { returnNumber: returnInvoice.returnNumber, reason },
    });

    notifyAdmins({
      title: 'Return Invoice Deletion Requested',
      message: `${actor.name || 'Cashier'} requested deletion of Return ${returnInvoice.returnNumber}.`,
      type: NotificationType.WARNING,
      link: `/return-invoices/${id}`,
      req,
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Return invoice deletion request submitted to admin for confirmation',
      data: withDerivedReturnMoney(result, money),
    });
  }
});

const confirmDeleteReturnInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const returnInvoice = await prisma.returnInvoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!returnInvoice || returnInvoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Return invoice not found');
  }

  await assertLatestForMutation(returnInvoice, 'deleted');

  const warnings: string[] = [];
  const result = await prisma.$transaction(async tx => {
    await deductStockForProductItems(tx, returnInvoice.items, warnings);
    return tx.returnInvoice.update({
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
    action: 'ADMIN_CONFIRM_DELETE_RETURN_INVOICE',
    entityType: 'RETURN_INVOICE',
    entityId: id,
    req,
    details: { returnNumber: returnInvoice.returnNumber },
  });

  if (returnInvoice.deleteRequestedById) {
    sendNotification({
      userId: returnInvoice.deleteRequestedById,
      title: 'Return Invoice Deletion Confirmed',
      message: `Admin confirmed deletion for Return ${returnInvoice.returnNumber}.`,
      type: NotificationType.SUCCESS,
      link: `/return-invoices`,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Return invoice deletion confirmed and inventory adjusted',
    data: { returnInvoice: result, warnings },
  });
});

const rejectDeleteReturnInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const returnInvoice = await prisma.returnInvoice.findUnique({ where: { id } });

  if (!returnInvoice || returnInvoice.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Return invoice not found');
  }

  const result = await prisma.returnInvoice.update({
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
    action: 'ADMIN_REJECT_DELETE_RETURN_INVOICE',
    entityType: 'RETURN_INVOICE',
    entityId: id,
    req,
    details: { returnNumber: returnInvoice.returnNumber },
  });

  if (returnInvoice.deleteRequestedById) {
    sendNotification({
      userId: returnInvoice.deleteRequestedById,
      title: 'Return Invoice Deletion Rejected',
      message: `Admin rejected deletion request for Return ${returnInvoice.returnNumber}.`,
      type: NotificationType.WARNING,
      link: `/return-invoices/${id}`,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Return invoice deletion request rejected',
    data: result,
  });
});

/**
 * Restore soft-deleted return invoice and re-apply stock restore.
 * Blocked when a newer active return already exists on the invoice.
 */
const restoreReturnInvoice = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const returnInvoice = await prisma.returnInvoice.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!returnInvoice || !returnInvoice.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Return invoice is not in deleted state');
  }

  if (await hasNewerActiveReturn(prisma, returnInvoice)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot restore; a newer return invoice already exists on this invoice',
    );
  }

  const { enriched } = await enrichReturnItemsFromInvoice(
    returnInvoice.invoiceId,
    returnInvoice.items.map(it => ({
      invoiceItemId: it.invoiceItemId,
      quantity: it.quantity,
      sellingPrice: it.sellingPrice,
      discounts: it.discounts,
    })),
  );

  const result = await prisma.$transaction(async tx => {
    await restoreStockForProductItems(tx, enriched, []);

    return tx.returnInvoice.update({
      where: { id },
      data: {
        isDeleted: false,
        isDeleteRequested: false,
        deleteRequestedById: null,
        deleteRequestedAt: null,
        deleteReason: null,
        updatedById: actor.id,
      },
      include: returnInvoiceInclude,
    });
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_RESTORE_RETURN_INVOICE',
    entityType: 'RETURN_INVOICE',
    entityId: id,
    req,
    details: { returnNumber: returnInvoice.returnNumber },
  });

  const hydrated = await hydrateReturnInvoice(result);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Return invoice restored successfully',
    data: {
      returnInvoice: { ...hydrated, isLatest: true, canRestore: false },
    },
  });
});

export const ReturnInvoiceServices = {
  createReturnInvoice,
  getAllReturnInvoices,
  getReturnInvoiceById,
  getReturnableItemsByInvoice,
  updateReturnInvoice,
  updateReturnInvoiceStatus,
  deleteReturnInvoice,
  confirmDeleteReturnInvoice,
  rejectDeleteReturnInvoice,
  restoreReturnInvoice,
};
