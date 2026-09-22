import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import { ReceiptStatus } from '../../../generated/prisma/client';
import {
  DASHBOARD_TZ,
  DASHBOARD_TZ_OFFSET,
  LOW_STOCK_THRESHOLD,
  TOP_PRODUCTS_LIMIT,
  TREND_MONTHS,
} from './stats.constant';
import {
  aggregateByMonth,
  aggregateSummary,
  aggregateTopProducts,
  buildProfitBreakdown,
  endOfMonthDhaka,
  generateMonthKeys,
  lastMonthKeys,
  resolveDashboardRange,
  startOfMonthDhaka,
  toDhakaDateString,
  type AnalyticsLine,
} from './stats.analytics.utils';
import {
  parseDashboardQuery,
  parseLowStockQuery,
  parseMonthRangeQuery,
} from './stats.validation';

/**
 * Loads receipt lines (with returned qty) for receipts created in [gte, lte].
 * Same eligibility as the product profit report: not deleted, not rejected,
 * product-linked lines, returns (not deleted/rejected) created in the same range.
 */
const loadAnalyticsLines = async (
  gte?: Date,
  lte?: Date,
): Promise<AnalyticsLine[]> => {
  const createdAt =
    gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;

  const receipts = await prisma.receipt.findMany({
    where: {
      isDeleted: false,
      status: { not: ReceiptStatus.REJECTED },
      ...(createdAt ? { createdAt } : {}),
    },
    select: {
      createdAt: true,
      items: {
        where: { productId: { not: null } },
        select: {
          id: true,
          productId: true,
          productName: true,
          quantity: true,
          totalPrice: true,
          sellingPrice: true,
          buyingPrice: true,
          product: { select: { name: true, buyingPrice: true } },
        },
      },
    },
  });

  const itemIds = receipts.flatMap(r => r.items.map(i => i.id));
  const returnedByItem = new Map<string, number>();

  if (itemIds.length > 0) {
    const returnRows = await prisma.returnInvoiceItem.findMany({
      where: {
        receiptItemId: { in: itemIds },
        returnInvoice: {
          isDeleted: false,
          status: { not: ReceiptStatus.REJECTED },
          ...(createdAt ? { createdAt } : {}),
        },
      },
      select: { receiptItemId: true, quantity: true },
    });
    for (const row of returnRows) {
      returnedByItem.set(
        row.receiptItemId,
        (returnedByItem.get(row.receiptItemId) || 0) + Number(row.quantity),
      );
    }
  }

  return receipts.flatMap(r =>
    r.items.map(item => ({
      receiptCreatedAt: r.createdAt,
      productId: item.productId as string,
      productName: item.product?.name || item.productName,
      quantity: item.quantity,
      totalPrice: item.totalPrice,
      sellingPrice: item.sellingPrice,
      buyingPrice: item.buyingPrice,
      productBuyingPrice: item.product?.buyingPrice ?? null,
      returnedQty: returnedByItem.get(item.id) || 0,
    })),
  );
};

const dayRange = (startDate: string, endDate: string) => ({
  gte: new Date(`${startDate}T00:00:00.000${DASHBOARD_TZ_OFFSET}`),
  lte: new Date(`${endDate}T23:59:59.999${DASHBOARD_TZ_OFFSET}`),
});

const getLowStockCount = () =>
  prisma.product.count({
    where: { isDeleted: false, stock: { lte: LOW_STOCK_THRESHOLD } },
  });

const getTotalCustomerCount = () =>
  prisma.customer.count({
    where: { isDeleted: false },
  });

const getDashboardSummary = catchAsync(async (req, res) => {
  const query = parseDashboardQuery(req.query);
  const todayStr = toDhakaDateString(new Date());

  let firstReceiptDate: string | null = null;
  if (query.preset === 'all') {
    const first = await prisma.receipt.findFirst({
      where: { isDeleted: false, status: { not: ReceiptStatus.REJECTED } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    firstReceiptDate = first ? toDhakaDateString(first.createdAt) : null;
  }

  const { startDate, endDate } = resolveDashboardRange(
    query.preset,
    todayStr,
    query,
    firstReceiptDate,
  );
  const { gte, lte } = dayRange(startDate, endDate);

  const [lines, lowStockCount, totalCustomers] = await Promise.all([
    loadAnalyticsLines(gte, lte),
    getLowStockCount(),
    getTotalCustomerCount(),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Dashboard summary retrieved successfully',
    data: {
      range: {
        preset: query.preset,
        startDate,
        endDate,
        timezone: DASHBOARD_TZ,
      },
      summary: { ...aggregateSummary(lines), totalCustomers, lowStockCount },
      topProducts: aggregateTopProducts(lines, TOP_PRODUCTS_LIMIT),
    },
  });
});

const loadMonthlySeries = async (startMonth?: string, endMonth?: string) => {
  const monthKeys =
    startMonth && endMonth
      ? generateMonthKeys(startMonth, endMonth)
      : lastMonthKeys(toDhakaDateString(new Date()), TREND_MONTHS);

  if (monthKeys.length === 0) return [];

  const gte = startOfMonthDhaka(monthKeys[0]);
  const lte = endOfMonthDhaka(monthKeys[monthKeys.length - 1]);
  const lines = await loadAnalyticsLines(gte, lte);
  return aggregateByMonth(lines, monthKeys);
};

const getSalesPerformance = catchAsync(async (req, res) => {
  const { startMonth, endMonth } = parseMonthRangeQuery(req.query);
  const points = await loadMonthlySeries(startMonth, endMonth);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Sales performance retrieved successfully',
    data: points,
  });
});

const getProfitBreakdown = catchAsync(async (req, res) => {
  const { startMonth, endMonth } = parseMonthRangeQuery(req.query);
  const points = await loadMonthlySeries(startMonth, endMonth);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Profit breakdown retrieved successfully',
    data: buildProfitBreakdown(points),
  });
});

const getLowStock = catchAsync(async (req, res) => {
  const q = parseLowStockQuery(req.query);
  const where = {
    isDeleted: false,
    stock: { lte: LOW_STOCK_THRESHOLD },
    ...(q.searchTerm
      ? { name: { contains: q.searchTerm, mode: 'insensitive' as const } }
      : {}),
  };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        unit: true,
        stock: true,
        sellingPrice: true,
        buyingPrice: true,
      },
      orderBy:
        q.sortBy === 'name'
          ? [{ name: q.sortOrder }]
          : [{ stock: q.sortOrder }, { name: 'asc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Low stock products retrieved successfully',
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPage: total === 0 ? 0 : Math.ceil(total / q.limit),
    },
    data: { threshold: LOW_STOCK_THRESHOLD, products },
  });
});

export const DashboardStatsServices = {
  getDashboardSummary,
  getSalesPerformance,
  getProfitBreakdown,
  getLowStock,
};
