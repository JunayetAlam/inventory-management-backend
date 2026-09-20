import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import { roundToTwo } from '../Receipt/receipt.utils';
import {
  computeReceiptLiveTotals,
  sumCustomersSignedDue,
} from '../Customer/customer.utils';

const getDhakaDateRanges = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [yearStr, monthStr, dayStr] = formatter.format(now).split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);

  const todayStart = new Date(`${yearStr}-${monthStr}-${dayStr}T00:00:00.000+06:00`);
  const todayEnd = new Date(`${yearStr}-${monthStr}-${dayStr}T23:59:59.999+06:00`);

  const monthStart = new Date(`${yearStr}-${monthStr}-01T00:00:00.000+06:00`);
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = new Date(
    `${yearStr}-${monthStr}-${String(lastDayOfMonth).padStart(2, '0')}T23:59:59.999+06:00`,
  );

  const yearStart = new Date(`${yearStr}-01-01T00:00:00.000+06:00`);
  const yearEnd = new Date(`${yearStr}-12-31T23:59:59.999+06:00`);

  return {
    todayStart,
    todayEnd,
    monthStart,
    monthEnd,
    yearStart,
    yearEnd,
  };
};

const getPeriodDeposit = async (gte?: Date, lte?: Date): Promise<number> => {
  const result = await prisma.receiptPayment.aggregate({
    where: {
      receipt: {
        isDeleted: false,
        customer: { isDeleted: false },
      },
      ...(gte || lte
        ? {
            createdAt: {
              ...(gte ? { gte } : {}),
              ...(lte ? { lte } : {}),
            },
          }
        : {}),
    },
    _sum: { amount: true },
  });

  return roundToTwo(result._sum.amount || 0);
};

const getPeriodDue = async (gte?: Date, lte?: Date): Promise<number> => {
  const receipts = await prisma.receipt.findMany({
    where: {
      isDeleted: false,
      customer: { isDeleted: false },
      ...(gte || lte
        ? {
            createdAt: {
              ...(gte ? { gte } : {}),
              ...(lte ? { lte } : {}),
            },
          }
        : {}),
    },
    select: {
      customerId: true,
      totalAmount: true,
      paidAmount: true,
      dueAmount: true,
      discount: true,
      returnInvoices: {
        where: { isDeleted: false },
        select: {
          id: true,
          discount: true,
          refundedAmount: true,
          previousReturnInvoiceId: true,
          createdAt: true,
          returnNumber: true,
          items: {
            select: {
              sellingPrice: true,
              quantity: true,
              discount: true,
              totalPrice: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { returnNumber: 'desc' }],
      },
    },
  });

  let due = 0;
  for (const receipt of receipts) {
    const live = computeReceiptLiveTotals(receipt);
    due += live.due;
  }

  return roundToTwo(due);
};

/**
 * Active-customer stats:
 * - Total customers count
 * - Today (due & deposit)
 * - This month (due & deposit)
 * - This year (due & deposit)
 * - Total (due & deposit)
 */
const getCustomerStats = catchAsync(async (_req, res) => {
  const customers = await prisma.customer.findMany({
    where: { isDeleted: false },
    select: { id: true },
  });

  const totalCustomers = customers.length;
  const { todayStart, todayEnd, monthStart, monthEnd, yearStart, yearEnd } =
    getDhakaDateRanges();

  const [
    todayDeposit,
    todayDue,
    thisMonthDeposit,
    thisMonthDue,
    thisYearDeposit,
    thisYearDue,
    totalDeposit,
    totalDue,
  ] = await Promise.all([
    getPeriodDeposit(todayStart, todayEnd),
    getPeriodDue(todayStart, todayEnd),
    getPeriodDeposit(monthStart, monthEnd),
    getPeriodDue(monthStart, monthEnd),
    getPeriodDeposit(yearStart, yearEnd),
    getPeriodDue(yearStart, yearEnd),
    getPeriodDeposit(),
    roundToTwo(
      await sumCustomersSignedDue(
        prisma,
        customers.map(customer => customer.id),
      ),
    ),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Customer stats retrieved successfully',
    data: {
      totalCustomers,
      totalDue, // keep for backward compatibility
      today: {
        due: todayDue,
        deposit: todayDeposit,
      },
      thisMonth: {
        due: thisMonthDue,
        deposit: thisMonthDeposit,
      },
      thisYear: {
        due: thisYearDue,
        deposit: thisYearDeposit,
      },
      total: {
        due: totalDue,
        deposit: totalDeposit,
      },
    },
  });
});

export const StatsServices = {
  getCustomerStats,
};
