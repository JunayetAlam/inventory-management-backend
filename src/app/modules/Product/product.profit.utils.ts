import { roundToTwo } from '../Invoice/invoice.utils';
import { PRODUCT_PROFIT_DATE_TZ_OFFSET } from './product.constant';
import type { ProductProfitSortField } from './product.constant';

/**
 * Inclusive calendar-day range in Asia/Dhaka (+06:00).
 * startDate YYYY-MM-DD → 00:00:00.000+06:00
 * endDate   YYYY-MM-DD → 23:59:59.999+06:00
 */
export const buildCreatedAtRange = (
  startDate?: string,
  endDate?: string,
): { gte?: Date; lte?: Date } | undefined => {
  if (!startDate && !endDate) return undefined;

  const range: { gte?: Date; lte?: Date } = {};

  if (startDate) {
    range.gte = new Date(
      `${startDate}T00:00:00.000${PRODUCT_PROFIT_DATE_TZ_OFFSET}`,
    );
  }
  if (endDate) {
    range.lte = new Date(
      `${endDate}T23:59:59.999${PRODUCT_PROFIT_DATE_TZ_OFFSET}`,
    );
  }

  return range;
};

export interface ProductProfitInvoiceRef {
  id: string;
  invoiceNumber: string;
  /** Net sold qty of this product on that invoice (after in-range returns) */
  quantity: number;
}

export interface ProductProfitAgg {
  productId: string;
  productName: string;
  unit: string;
  soldQty: number;
  salesTotal: number;
  purchaseCost: number;
  /** Qty where buyingPrice was missing and sell unit price was used as cost */
  assumedBuyFromSellQty: number;
  invoicesById: Map<string, { invoiceNumber: string; quantity: number }>;
}

export interface ProductProfitRow {
  productId: string;
  productName: string;
  unit: string;
  soldQty: number;
  salesTotal: number;
  purchaseCost: number;
  assumedBuyFromSellQty: number;
  avgPurchase: number | null;
  avgSale: number | null;
  profit: number;
  profitPercent: number | null;
  invoices: ProductProfitInvoiceRef[];
}

export const emptyProductAgg = (
  productId: string,
  productName: string,
  unit: string,
): ProductProfitAgg => ({
  productId,
  productName,
  unit,
  soldQty: 0,
  salesTotal: 0,
  purchaseCost: 0,
  assumedBuyFromSellQty: 0,
  invoicesById: new Map(),
});

/**
 * Net line contribution after date-bounded return qty.
 * When buyingPrice is missing, cost uses selling price per unit (zero profit on that qty).
 * @returns netQty contributed (0 if nothing counted)
 */
export const contributeInvoiceLine = (
  agg: ProductProfitAgg,
  line: {
    quantity: number;
    totalPrice: number;
    sellingPrice: number;
    buyingPrice: number | null;
  },
  returnedQty: number,
  invoice?: { id: string; invoiceNumber: string },
): number => {
  const qty = Number(line.quantity) || 0;
  if (qty <= 0) return 0;

  const netQty = roundToTwo(Math.max(0, qty - Math.max(0, returnedQty)));
  if (netQty <= 0) return 0;

  const effectiveSell = Number(line.totalPrice) / qty;
  const unitSell =
    Number.isFinite(Number(line.sellingPrice)) && Number(line.sellingPrice) >= 0
      ? Number(line.sellingPrice)
      : effectiveSell;

  const rawBuy = line.buyingPrice;
  const buyMissing = rawBuy == null || Number.isNaN(Number(rawBuy));
  const unitBuy = buyMissing ? unitSell : Number(rawBuy);

  agg.soldQty = roundToTwo(agg.soldQty + netQty);
  agg.salesTotal = roundToTwo(agg.salesTotal + effectiveSell * netQty);
  agg.purchaseCost = roundToTwo(agg.purchaseCost + unitBuy * netQty);

  if (buyMissing) {
    agg.assumedBuyFromSellQty = roundToTwo(
      agg.assumedBuyFromSellQty + netQty,
    );
  }

  if (invoice?.id && invoice.invoiceNumber) {
    const existing = agg.invoicesById.get(invoice.id);
    if (existing) {
      existing.quantity = roundToTwo(existing.quantity + netQty);
    } else {
      agg.invoicesById.set(invoice.id, {
        invoiceNumber: invoice.invoiceNumber,
        quantity: netQty,
      });
    }
  }

  return netQty;
};

export const finalizeProductRow = (agg: ProductProfitAgg): ProductProfitRow => {
  const soldQty = roundToTwo(agg.soldQty);
  const salesTotal = roundToTwo(agg.salesTotal);
  const purchaseCost = roundToTwo(agg.purchaseCost);
  const assumedBuyFromSellQty = roundToTwo(agg.assumedBuyFromSellQty);
  const profit = roundToTwo(salesTotal - purchaseCost);

  const invoices: ProductProfitInvoiceRef[] = Array.from(
    agg.invoicesById.entries(),
  )
    .map(([id, ref]) => ({
      id,
      invoiceNumber: ref.invoiceNumber,
      quantity: roundToTwo(ref.quantity),
    }))
    .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));

  return {
    productId: agg.productId,
    productName: agg.productName,
    unit: agg.unit,
    soldQty,
    salesTotal,
    purchaseCost,
    assumedBuyFromSellQty,
    avgPurchase: soldQty > 0 ? roundToTwo(purchaseCost / soldQty) : null,
    avgSale: soldQty > 0 ? roundToTwo(salesTotal / soldQty) : null,
    profit,
    profitPercent:
      salesTotal > 0 ? roundToTwo((profit / salesTotal) * 100) : null,
    invoices,
  };
};

export const sortProductProfitRows = (
  rows: ProductProfitRow[],
  sortBy: ProductProfitSortField,
  sortOrder: 'asc' | 'desc',
): ProductProfitRow[] => {
  const dir = sortOrder === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (sortBy === 'name') {
      return a.productName.localeCompare(b.productName) * dir;
    }

    const av = a[sortBy];
    const bv = b[sortBy];
    const an = av == null ? Number.NEGATIVE_INFINITY : Number(av);
    const bn = bv == null ? Number.NEGATIVE_INFINITY : Number(bv);
    if (an === bn) {
      return a.productName.localeCompare(b.productName);
    }
    return (an - bn) * dir;
  });
};

export const summarizeProductProfit = (rows: ProductProfitRow[]) => {
  let soldQty = 0;
  let salesTotal = 0;
  let purchaseCost = 0;

  for (const row of rows) {
    soldQty = roundToTwo(soldQty + row.soldQty);
    salesTotal = roundToTwo(salesTotal + row.salesTotal);
    purchaseCost = roundToTwo(purchaseCost + row.purchaseCost);
  }

  const profit = roundToTwo(salesTotal - purchaseCost);

  return {
    soldQty,
    salesTotal,
    purchaseCost,
    profit,
    profitPercent:
      salesTotal > 0 ? roundToTwo((profit / salesTotal) * 100) : null,
    productCount: rows.length,
  };
};
