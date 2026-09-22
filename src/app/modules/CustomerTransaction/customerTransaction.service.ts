import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import { CustomerTransactionType, Prisma } from '../../../generated/prisma/client';
import { roundToTwo } from '../Receipt/receipt.utils';

// Helper to backfill historical receipts, payments, and return invoices into CustomerTransaction
export const syncMissingCustomerTransactions = async () => {
  // 1. Backfill Receipts
  const receiptsWithoutTx = await prisma.receipt.findMany({
    where: {
      transactions: {
        none: {
          type: CustomerTransactionType.RECEIPT,
        },
      },
    },
    select: {
      id: true,
      customerId: true,
      note: true,
      createdById: true,
      createdAt: true,
      paidAmount: true,
    },
  });

  for (const r of receiptsWithoutTx) {
    await prisma.customerTransaction.create({
      data: {
        customerId: r.customerId,
        type: CustomerTransactionType.RECEIPT,
        receiptId: r.id,
        note: r.note || null,
        createdById: r.createdById || null,
        createdAt: r.createdAt,
      },
    });

    // If initial payment was recorded without a ReceiptPayment record
    if (r.paidAmount > 0) {
      const existingPayment = await prisma.receiptPayment.findFirst({
        where: { receiptId: r.id },
      });
      if (!existingPayment) {
        const payment = await prisma.receiptPayment.create({
          data: {
            receiptId: r.id,
            amount: r.paidAmount,
            note: 'Initial payment upon receipt creation',
            createdById: r.createdById || null,
            createdAt: r.createdAt,
          },
        });
        await prisma.customerTransaction.create({
          data: {
            customerId: r.customerId,
            type: CustomerTransactionType.PAYMENT,
            receiptId: r.id,
            paymentId: payment.id,
            note: payment.note,
            createdById: r.createdById || null,
            createdAt: r.createdAt,
          },
        });
      }
    }
  }

  // 2. Backfill ReceiptPayments
  const paymentsWithoutTx = await prisma.receiptPayment.findMany({
    where: {
      transactions: {
        none: {
          type: CustomerTransactionType.PAYMENT,
        },
      },
    },
    include: {
      receipt: {
        select: {
          customerId: true,
        },
      },
    },
  });

  for (const p of paymentsWithoutTx) {
    if (p.receipt?.customerId) {
      await prisma.customerTransaction.create({
        data: {
          customerId: p.receipt.customerId,
          type: CustomerTransactionType.PAYMENT,
          receiptId: p.receiptId,
          paymentId: p.id,
          note: p.note || null,
          createdById: p.createdById || null,
          createdAt: p.createdAt,
        },
      });
    }
  }

  // 3. Backfill ReturnInvoices
  const returnsWithoutTx = await prisma.returnInvoice.findMany({
    where: {
      transactions: {
        none: {
          type: CustomerTransactionType.RETURN_INVOICE,
        },
      },
    },
    include: {
      receipt: {
        select: {
          customerId: true,
        },
      },
    },
  });

  for (const ret of returnsWithoutTx) {
    if (ret.receipt?.customerId) {
      await prisma.customerTransaction.create({
        data: {
          customerId: ret.receipt.customerId,
          type: CustomerTransactionType.RETURN_INVOICE,
          receiptId: ret.receiptId,
          returnInvoiceId: ret.id,
          note: ret.note || null,
          createdById: ret.createdById || null,
          createdAt: ret.createdAt,
        },
      });
    }
  }
};

const buildTransactionFilter = (query: Record<string, any>): Prisma.CustomerTransactionWhereInput => {
  const where: Prisma.CustomerTransactionWhereInput = {};

  if (query.customerId) {
    where.customerId = query.customerId;
  }

  if (query.type && Object.values(CustomerTransactionType).includes(query.type as CustomerTransactionType)) {
    where.type = query.type as CustomerTransactionType;
  }

  if (query.startDate || query.endDate) {
    where.createdAt = {};
    if (query.startDate) {
      const s = new Date(query.startDate);
      s.setHours(0, 0, 0, 0);
      where.createdAt.gte = s;
    }
    if (query.endDate) {
      const e = new Date(query.endDate);
      e.setHours(23, 59, 59, 999);
      where.createdAt.lte = e;
    }
  }

  if (query.searchTerm && String(query.searchTerm).trim()) {
    const term = String(query.searchTerm).trim();
    where.OR = [
      { note: { contains: term, mode: 'insensitive' } },
      { customer: { name: { contains: term, mode: 'insensitive' } } },
      { customer: { phoneNumber: { contains: term, mode: 'insensitive' } } },
      { receipt: { receiptNumber: { contains: term, mode: 'insensitive' } } },
      { returnInvoice: { returnNumber: { contains: term, mode: 'insensitive' } } },
    ];
  }

  return where;
};

const getAllCustomerTransactions = catchAsync(async (req, res) => {
  const query = req.query as Record<string, any>;

  // Check if initial sync is needed (if table is empty)
  const currentCount = await prisma.customerTransaction.count();
  if (currentCount === 0) {
    await syncMissingCustomerTransactions();
  }

  const where = buildTransactionFilter(query);

  const page = Math.max(1, Number(query.page) || 1);
  const isExportAll = String(query.limit || '').toLowerCase() === 'all';
  const limit = isExportAll ? undefined : Math.max(1, Number(query.limit) || 25);
  const skip = isExportAll ? undefined : (page - 1) * (limit || 25);

  const sortBy = query.sortBy || 'createdAt';
  const sortOrder = (query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const [total, transactions] = await Promise.all([
    prisma.customerTransaction.count({ where }),
    prisma.customerTransaction.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ [sortBy]: sortOrder }, { id: sortOrder }],
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phoneNumber: true,
            countryCode: true,
            email: true,
            image: true,
          },
        },
        receipt: {
          select: {
            id: true,
            receiptNumber: true,
            totalAmount: true,
            paidAmount: true,
            dueAmount: true,
            status: true,
            note: true,
            createdAt: true,
          },
        },
        payment: {
          select: {
            id: true,
            amount: true,
            note: true,
            status: true,
            createdAt: true,
            createdBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        returnInvoice: {
          select: {
            id: true,
            returnNumber: true,
            refundedAmount: true,
            discount: true,
            status: true,
            note: true,
            createdAt: true,
            items: {
              select: {
                totalPrice: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    }),
  ]);

  // Compute exact running balances for all customers in the returned results
  const targetCustomerIds = [...new Set(transactions.map((t) => t.customerId))];
  const balanceByTxId = new Map<string, number>();

  if (targetCustomerIds.length > 0) {
    const allCustomerTxs = await prisma.customerTransaction.findMany({
      where: {
        customerId: { in: targetCustomerIds },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        customerId: true,
        type: true,
        receipt: {
          select: {
            totalAmount: true,
          },
        },
        payment: {
          select: {
            amount: true,
          },
        },
        returnInvoice: {
          select: {
            discount: true,
            refundedAmount: true,
            items: {
              select: {
                totalPrice: true,
              },
            },
          },
        },
      },
    });

    const runningBalanceByCustomer = new Map<string, number>();

    for (const rawTx of allCustomerTxs) {
      let txDue = 0;
      let txCash = 0;

      if (rawTx.type === CustomerTransactionType.RECEIPT && rawTx.receipt) {
        txDue = rawTx.receipt.totalAmount;
      } else if (rawTx.type === CustomerTransactionType.PAYMENT && rawTx.payment) {
        txCash = rawTx.payment.amount;
      } else if (rawTx.type === CustomerTransactionType.RETURN_INVOICE && rawTx.returnInvoice) {
        const itemsTotal = (rawTx.returnInvoice.items || []).reduce((s, it) => s + it.totalPrice, 0);
        const discount = rawTx.returnInvoice.discount || 0;
        const returnMoney = rawTx.returnInvoice.refundedAmount || 0;
        txCash = itemsTotal > 0 ? Math.max(0, itemsTotal - discount - returnMoney) : returnMoney;
      }

      const prev = runningBalanceByCustomer.get(rawTx.customerId) || 0;
      const current = roundToTwo(prev + txDue - txCash);
      runningBalanceByCustomer.set(rawTx.customerId, current);
      balanceByTxId.set(rawTx.id, current);
    }
  }

  // Format each transaction with Due, Cash, and Balance
  const formattedData = transactions.map((tx) => {
    let due = 0;
    let cash = 0;
    let referenceNumber = '';

    if (tx.type === CustomerTransactionType.RECEIPT && tx.receipt) {
      due = tx.receipt.totalAmount;
      cash = 0;
      referenceNumber = tx.receipt.receiptNumber;
    } else if (tx.type === CustomerTransactionType.PAYMENT && tx.payment) {
      due = 0;
      cash = tx.payment.amount;
      referenceNumber = tx.receipt?.receiptNumber ? `${tx.receipt.receiptNumber}` : 'Payment';
    } else if (tx.type === CustomerTransactionType.RETURN_INVOICE && tx.returnInvoice) {
      due = 0;
      const itemsTotal = (tx.returnInvoice.items || []).reduce((s, it) => s + it.totalPrice, 0);
      const discount = tx.returnInvoice.discount || 0;
      const returnMoney = tx.returnInvoice.refundedAmount || 0;
      cash = itemsTotal > 0 ? Math.max(0, itemsTotal - discount - returnMoney) : returnMoney;
      referenceNumber = tx.returnInvoice.returnNumber;
    }

    const balance = balanceByTxId.get(tx.id) ?? 0;

    return {
      ...tx,
      due: roundToTwo(due),
      cash: roundToTwo(cash),
      balance: roundToTwo(balance),
      referenceNumber,
    };
  });

  const totalPage = isExportAll ? 1 : Math.ceil(total / (limit || 25));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer transactions retrieved successfully',
    data: formattedData,
    meta: {
      page: isExportAll ? 1 : page,
      limit: isExportAll ? total : limit || 25,
      total,
      totalPage,
    },
  });
});

const getCustomerTransactionStats = catchAsync(async (req, res) => {
  const query = req.query as Record<string, any>;

  // Check if sync is needed
  const currentCount = await prisma.customerTransaction.count();
  if (currentCount === 0) {
    await syncMissingCustomerTransactions();
  }

  const where = buildTransactionFilter(query);

  // 1. Total Transactions count matching filter
  const totalTransactions = await prisma.customerTransaction.count({ where });

  // 2. Fetch all matching transactions to calculate exact totalDue, totalCash, and totalBalance
  const matchingTxs = await prisma.customerTransaction.findMany({
    where,
    select: {
      type: true,
      receipt: {
        select: {
          totalAmount: true,
        },
      },
      payment: {
        select: {
          amount: true,
        },
      },
      returnInvoice: {
        select: {
          discount: true,
          refundedAmount: true,
          items: {
            select: {
              totalPrice: true,
            },
          },
        },
      },
    },
  });

  let totalDue = 0;
  let totalPayment = 0;

  for (const tx of matchingTxs) {
    if (tx.type === CustomerTransactionType.RECEIPT && tx.receipt) {
      totalDue = roundToTwo(totalDue + tx.receipt.totalAmount);
    } else if (tx.type === CustomerTransactionType.PAYMENT && tx.payment) {
      totalPayment = roundToTwo(totalPayment + tx.payment.amount);
    } else if (tx.type === CustomerTransactionType.RETURN_INVOICE && tx.returnInvoice) {
      const itemsTotal = (tx.returnInvoice.items || []).reduce((s, it) => s + it.totalPrice, 0);
      const discount = tx.returnInvoice.discount || 0;
      const returnMoney = tx.returnInvoice.refundedAmount || 0;
      const returnCredit = itemsTotal > 0 ? Math.max(0, itemsTotal - discount - returnMoney) : returnMoney;
      totalPayment = roundToTwo(totalPayment + returnCredit);
    }
  }

  const totalBalance = roundToTwo(totalDue - totalPayment);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer transaction stats retrieved successfully',
    data: {
      totalTransactions,
      totalDue,
      totalPayment,
      totalBalance,
    },
  });
});

const triggerSyncTransactions = catchAsync(async (req, res) => {
  await syncMissingCustomerTransactions();
  const count = await prisma.customerTransaction.count();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer transactions synced successfully',
    data: { count },
  });
});

export const CustomerTransactionServices = {
  getAllCustomerTransactions,
  getCustomerTransactionStats,
  triggerSyncTransactions,
};
