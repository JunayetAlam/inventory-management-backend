import { describe, expect, test } from 'bun:test';
import {
  aggregateByMonth,
  aggregateSummary,
  buildProfitBreakdown,
  computeLine,
  endOfMonthDhaka,
  generateMonthKeys,
  lastMonthKeys,
  resolveDashboardRange,
  toDhakaMonthKey,
  type AnalyticsLine,
} from './stats.analytics.utils';

const line = (over: Partial<AnalyticsLine> = {}): AnalyticsLine => ({
  receiptCreatedAt: new Date('2026-09-10T06:00:00.000Z'),
  productId: 'p1',
  productName: 'P1',
  quantity: 10,
  totalPrice: 1000, // sell 100/unit
  sellingPrice: 100,
  buyingPrice: 60,
  productBuyingPrice: 70,
  returnedQty: 0,
  ...over,
});

describe('computeLine', () => {
  test('uses receipt item buying price', () => {
    expect(computeLine(line())).toEqual({ netQty: 10, sales: 1000, cost: 600 });
  });
  test('returns reduce both sales and cost', () => {
    expect(computeLine(line({ returnedQty: 4 }))).toEqual({
      netQty: 6,
      sales: 600,
      cost: 360,
    });
  });
  test('falls back to current product buying price', () => {
    expect(computeLine(line({ buyingPrice: null })).cost).toBe(700);
  });
  test('falls back to sell price when no cost known', () => {
    const r = computeLine(line({ buyingPrice: null, productBuyingPrice: null }));
    expect(r.sales - r.cost).toBe(0);
  });
  test('over-returned qty never goes negative', () => {
    expect(computeLine(line({ returnedQty: 99 })).netQty).toBe(0);
  });
});

describe('aggregateSummary', () => {
  test('sums sales and expenses', () => {
    expect(aggregateSummary([line(), line({ returnedQty: 10 })])).toEqual({
      totalSales: 1000,
      totalExpenses: 600,
    });
  });
  test('empty gives zeroes', () => {
    expect(aggregateSummary([])).toEqual({
      totalSales: 0,
      totalExpenses: 0,
    });
  });
});

describe('monthly buckets (Asia/Dhaka)', () => {
  test('boundary: 2026-08-31T18:00Z is 1 Sep in Dhaka', () => {
    expect(toDhakaMonthKey(new Date('2026-08-31T18:00:00.000Z'))).toBe('2026-09');
    expect(toDhakaMonthKey(new Date('2026-08-31T17:59:59.000Z'))).toBe('2026-08');
  });
  test('12 keys, oldest first, year rollover', () => {
    const keys = lastMonthKeys('2026-02-15', 12);
    expect(keys[0]).toBe('2025-03');
    expect(keys[11]).toBe('2026-02');
  });
  test('gap months are zero-filled and breakdown handles loss months', () => {
    const keys = lastMonthKeys('2026-09-20', 12);
    const pts = aggregateByMonth(
      [
        line(),
        line({
          receiptCreatedAt: new Date('2026-08-10T06:00:00.000Z'),
          buyingPrice: 150, // loss month
        }),
      ],
      keys,
    );
    expect(pts).toHaveLength(12);
    expect(pts[11].profit).toBe(400);
    expect(pts[10].profit).toBe(-500);
    expect(pts[0].sales).toBe(0);
    const b = buildProfitBreakdown(pts);
    expect(b.totalProfit).toBe(-100);
    expect(b.positiveTotal).toBe(400);
    expect(b.months[11].percent).toBe(100);
    expect(b.months[10].percent).toBeNull();
  });
});

describe('resolveDashboardRange', () => {
  // 2026-09-20 is a Sunday
  test('week is Monday-based', () => {
    expect(resolveDashboardRange('week', '2026-09-20', {}, null)).toEqual({
      startDate: '2026-09-14',
      endDate: '2026-09-20',
    });
  });
  test('month / today', () => {
    expect(resolveDashboardRange('month', '2026-09-20', {}, null).startDate).toBe(
      '2026-09-01',
    );
    expect(resolveDashboardRange('today', '2026-09-20', {}, null)).toEqual({
      startDate: '2026-09-20',
      endDate: '2026-09-20',
    });
  });
  test('all uses first receipt; custom clamps future end', () => {
    expect(
      resolveDashboardRange('all', '2026-09-20', {}, '2025-01-05').startDate,
    ).toBe('2025-01-05');
    expect(
      resolveDashboardRange(
        'custom',
        '2026-09-20',
        { startDate: '2026-09-01', endDate: '2027-01-01' },
        null,
      ),
    ).toEqual({ startDate: '2026-09-01', endDate: '2026-09-20' });
  });
});

describe('generateMonthKeys', () => {
  test('single month', () => {
    expect(generateMonthKeys('2025-05', '2025-05')).toEqual(['2025-05']);
  });
  test('same year multi-month', () => {
    expect(generateMonthKeys('2025-01', '2025-04')).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
    ]);
  });
  test('cross year multi-month', () => {
    expect(generateMonthKeys('2024-11', '2025-02')).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
  });
});

describe('endOfMonthDhaka', () => {
  test('calculates end of month timestamp in Dhaka timezone', () => {
    const endFeb = endOfMonthDhaka('2024-02'); // 2024 is leap year
    expect(endFeb.toISOString()).toBe('2024-02-29T17:59:59.999Z'); // +06:00 offset
  });
});
