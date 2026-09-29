import { roundToTwo } from '../Invoice/invoice.utils';
import {
  DASHBOARD_TZ,
  DASHBOARD_TZ_OFFSET,
  DASHBOARD_TZ_OFFSET_MS,
  type DashboardPreset,
} from './stats.constant';

export interface AnalyticsLine {
  invoiceCreatedAt: Date;
  productId: string;
  productName: string;
  quantity: number;
  totalPrice: number;
  sellingPrice: number;
  /** Cost snapshot stored on the invoice item */
  buyingPrice: number | null;
  /** Current product buying price (fallback when the snapshot is missing) */
  productBuyingPrice: number | null;
  returnedQty: number;
}

export interface LineResult {
  netQty: number;
  sales: number;
  cost: number;
}

/**
 * netQty  = max(0, qty - returnedQty)
 * sales   = (totalPrice / qty) * netQty          (line discount included)
 * cost    = netQty * unitBuy
 * unitBuy = invoice item buyingPrice -> current product buyingPrice -> effective sell price
 */
export const computeLine = (line: AnalyticsLine): LineResult => {
  const qty = Number(line.quantity);
  if (!(qty > 0)) return { netQty: 0, sales: 0, cost: 0 };

  const netQty = Math.max(0, qty - Number(line.returnedQty || 0));
  const effectiveSell = Number(line.totalPrice) / qty;
  const unitBuy = line.buyingPrice ?? line.productBuyingPrice ?? effectiveSell;

  return {
    netQty,
    sales: effectiveSell * netQty,
    cost: unitBuy * netQty,
  };
};

export interface SummaryTotals {
  totalSales: number;
  totalExpenses: number;
}

export const aggregateSummary = (lines: AnalyticsLine[]): SummaryTotals => {
  let sales = 0;
  let cost = 0;
  for (const line of lines) {
    const r = computeLine(line);
    sales += r.sales;
    cost += r.cost;
  }
  const totalSales = roundToTwo(sales);
  const totalExpenses = roundToTwo(cost);
  return {
    totalSales,
    totalExpenses,
  };
};

export interface TopProductRow {
  productId: string;
  productName: string;
  soldQty: number;
  salesTotal: number;
  purchaseCost: number;
  profit: number;
  profitPercent: number | null;
}

export const aggregateTopProducts = (
  lines: AnalyticsLine[],
  limit: number,
): TopProductRow[] => {
  const map = new Map<
    string,
    { name: string; qty: number; sales: number; cost: number }
  >();

  for (const line of lines) {
    const r = computeLine(line);
    if (r.netQty <= 0) continue;
    const agg = map.get(line.productId) ?? {
      name: line.productName,
      qty: 0,
      sales: 0,
      cost: 0,
    };
    agg.qty += r.netQty;
    agg.sales += r.sales;
    agg.cost += r.cost;
    map.set(line.productId, agg);
  }

  return Array.from(map.entries())
    .map(([productId, a]) => {
      const salesTotal = roundToTwo(a.sales);
      const purchaseCost = roundToTwo(a.cost);
      const profit = roundToTwo(a.sales - a.cost);
      return {
        productId,
        productName: a.name,
        soldQty: roundToTwo(a.qty),
        salesTotal,
        purchaseCost,
        profit,
        profitPercent:
          salesTotal > 0 ? roundToTwo((profit / salesTotal) * 100) : null,
      };
    })
    .sort((a, b) => b.salesTotal - a.salesTotal || b.profit - a.profit)
    .slice(0, limit);
};

/* ---------- Dhaka calendar helpers ---------- */

const dhakaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DASHBOARD_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD of an instant in Asia/Dhaka. */
export const toDhakaDateString = (date: Date): string =>
  dhakaDateFormatter.format(date);

/** YYYY-MM of an instant in Asia/Dhaka. */
export const toDhakaMonthKey = (date: Date): string =>
  new Date(date.getTime() + DASHBOARD_TZ_OFFSET_MS).toISOString().slice(0, 7);

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const monthLabel = (key: string): string => {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
};

/** Last `count` month keys ending at the month of `todayStr`, oldest first. */
export const lastMonthKeys = (todayStr: string, count: number): string[] => {
  const [y, m] = todayStr.split('-').map(Number);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    keys.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  }
  return keys;
};

/** Generates an inclusive array of month keys [startMonth, ..., endMonth]. */
export const generateMonthKeys = (
  startMonth: string,
  endMonth: string,
): string[] => {
  const [startY, startM] = startMonth.split('-').map(Number);
  const [endY, endM] = endMonth.split('-').map(Number);

  const keys: string[] = [];
  let curY = startY;
  let curM = startM;

  while (curY < endY || (curY === endY && curM <= endM)) {
    keys.push(`${curY}-${String(curM).padStart(2, '0')}`);
    curM++;
    if (curM > 12) {
      curM = 1;
      curY++;
    }
  }
  return keys;
};

export const startOfMonthDhaka = (monthKey: string): Date =>
  new Date(`${monthKey}-01T00:00:00.000${DASHBOARD_TZ_OFFSET}`);

export const endOfMonthDhaka = (monthKey: string): Date => {
  const [y, m] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(
    `${monthKey}-${String(lastDay).padStart(2, '0')}T23:59:59.999${DASHBOARD_TZ_OFFSET}`,
  );
};

export interface MonthlyPoint {
  month: string;
  label: string;
  sales: number;
  expenses: number;
  profit: number;
}

export const aggregateByMonth = (
  lines: AnalyticsLine[],
  monthKeys: string[],
): MonthlyPoint[] => {
  const buckets = new Map(monthKeys.map(k => [k, { sales: 0, cost: 0 }]));

  for (const line of lines) {
    const bucket = buckets.get(toDhakaMonthKey(line.invoiceCreatedAt));
    if (!bucket) continue;
    const r = computeLine(line);
    bucket.sales += r.sales;
    bucket.cost += r.cost;
  }

  return monthKeys.map(month => {
    const b = buckets.get(month)!;
    return {
      month,
      label: monthLabel(month),
      sales: roundToTwo(b.sales),
      expenses: roundToTwo(b.cost),
      profit: roundToTwo(b.sales - b.cost),
    };
  });
};

export interface ProfitBreakdown {
  months: {
    month: string;
    label: string;
    profit: number;
    percent: number | null;
  }[];
  totalProfit: number;
  positiveTotal: number;
}

/** Pie share = month profit / sum of positive month profits (loss months get null). */
export const buildProfitBreakdown = (
  points: MonthlyPoint[],
): ProfitBreakdown => {
  const positiveTotal = roundToTwo(
    points.reduce((s, p) => s + (p.profit > 0 ? p.profit : 0), 0),
  );
  return {
    months: points.map(p => ({
      month: p.month,
      label: p.label,
      profit: p.profit,
      percent:
        p.profit > 0 && positiveTotal > 0
          ? roundToTwo((p.profit / positiveTotal) * 100)
          : null,
    })),
    totalProfit: roundToTwo(points.reduce((s, p) => s + p.profit, 0)),
    positiveTotal,
  };
};

/* ---------- Range resolution ---------- */

const addDays = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const resolveDashboardRange = (
  preset: DashboardPreset,
  todayStr: string,
  custom: { startDate?: string; endDate?: string },
  firstInvoiceDate: string | null,
): { startDate: string; endDate: string } => {
  switch (preset) {
    case 'today':
      return { startDate: todayStr, endDate: todayStr };
    case 'week': {
      // Monday-based current week
      const dow = new Date(`${todayStr}T00:00:00.000Z`).getUTCDay(); // 0 = Sun
      const sinceMonday = (dow + 6) % 7;
      return { startDate: addDays(todayStr, -sinceMonday), endDate: todayStr };
    }
    case 'month':
      return { startDate: `${todayStr.slice(0, 7)}-01`, endDate: todayStr };
    case 'all':
      return { startDate: firstInvoiceDate ?? todayStr, endDate: todayStr };
    case 'custom': {
      const endDate =
        custom.endDate && custom.endDate < todayStr ? custom.endDate : todayStr;
      const startDate =
        custom.startDate && custom.startDate <= endDate
          ? custom.startDate
          : endDate;
      return { startDate, endDate };
    }
  }
};
