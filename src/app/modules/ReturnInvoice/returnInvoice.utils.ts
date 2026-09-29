import { roundToTwo } from '../Invoice/invoice.utils';

const DUPLICATE_INVOICE_ITEM_MESSAGE =
  'Duplicate invoice item on return invoice; each source line can only appear once';

export const getDuplicateReturnItemMessage = () => DUPLICATE_INVOICE_ITEM_MESSAGE;

/**
 * Generate unique, monotonically increasing return invoice number: RET-00000001
 * Sequence never resets and never repeats, even if previous return invoices are deleted.
 */
export const generateReturnNumber = async (prismaClient: any): Promise<string> => {
  const prefix = 'RET-';

  // Find all return invoices starting with RET- (including isDeleted: true)
  const returnInvoices = await prismaClient.returnInvoice.findMany({
    where: {
      returnNumber: {
        startsWith: prefix,
      },
    },
    select: {
      returnNumber: true,
    },
  });

  let maxSeq = 0;
  for (const ret of returnInvoices) {
    if (!ret.returnNumber) continue;
    const match = ret.returnNumber.match(/^RET-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let candidate = `${prefix}${String(nextSeq).padStart(8, '0')}`;

  // Collision safety loop across all return invoices (active or deleted)
  while (true) {
    const existing = await prismaClient.returnInvoice.findFirst({
      where: { returnNumber: candidate },
      select: { id: true },
    });
    if (!existing) {
      break;
    }
    nextSeq++;
    candidate = `${prefix}${String(nextSeq).padStart(8, '0')}`;
  }

  return candidate;
};

export const getReturnItemsUniquenessError = (
  items: { invoiceItemId: string }[],
): string | null => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.invoiceItemId)) {
      return DUPLICATE_INVOICE_ITEM_MESSAGE;
    }
    seen.add(item.invoiceItemId);
  }
  return null;
};

export interface CalculatedReturnItem {
  invoiceItemId: string;
  invoiceId: string;
  productId: string | null;
  productName: string;
  unit: any;
  sellingPrice: number;
  quantity: number;
  discounts: number[];
  totalPrice: number;
}

/** Derived money — never persisted; always computed from product lines + inputs. */
export interface DerivedReturnMoney {
  subTotal: number;
  discount: number;
  totalAmount: number;
  refundedAmount: number;
  previousDueAmount: number;
  dueRefundAmount: number;
}

export interface CalculatedReturnTotals extends DerivedReturnMoney {
  calculatedItems: CalculatedReturnItem[];
}

/**
 * Line + header credit from product quantities/prices (item discount is %).
 */
export const calculateReturnCreditFromItems = (
  rawItems: {
    invoiceItemId?: string;
    invoiceId?: string;
    productId?: string | null;
    productName?: string;
    unit?: any;
    sellingPrice: number;
    quantity: number;
    discounts?: number[] | null;
    discount?: number | null;
  }[],
  overallDiscount = 0,
): {
  calculatedItems: CalculatedReturnItem[];
  subTotal: number;
  totalAmount: number;
  discount: number;
} => {
  let subTotal = 0;

  const calculatedItems: CalculatedReturnItem[] = rawItems.map(item => {
    const qty = Number(item.quantity);
    const unitPrice = Number(item.sellingPrice);
    const itemSubtotal = roundToTwo(qty * unitPrice);

    const rawDiscounts: number[] = Array.isArray(item.discounts)
      ? item.discounts
      : typeof item.discount === 'number' && item.discount > 0
        ? [item.discount]
        : [];

    const sanitizedDiscounts = rawDiscounts
      .map(d => Math.max(0, Math.min(100, Number(d) || 0)))
      .filter(d => d > 0);

    let currentPrice = itemSubtotal;
    for (const disc of sanitizedDiscounts) {
      currentPrice = roundToTwo(currentPrice * (1 - disc / 100));
    }
    const itemTotalPrice = roundToTwo(Math.max(0, currentPrice));

    subTotal = roundToTwo(subTotal + itemTotalPrice);

    return {
      invoiceItemId: item.invoiceItemId || '',
      invoiceId: item.invoiceId || '',
      productId: item.productId || null,
      productName: (item.productName || '').trim(),
      unit: item.unit || 'PIECE',
      sellingPrice: unitPrice,
      quantity: qty,
      discounts: sanitizedDiscounts,
      totalPrice: itemTotalPrice,
    };
  });

  const finalDiscount = roundToTwo(Math.max(0, Number(overallDiscount) || 0));
  const totalAmount = roundToTwo(Math.max(0, subTotal - finalDiscount));

  return {
    calculatedItems,
    subTotal,
    discount: finalDiscount,
    totalAmount,
  };
};

/**
 * Settle refund due from product credit + carried previous due + cash refunded.
 * due = max(0, previousDue + netCredit − refunded)
 */
export const deriveReturnMoney = (
  rawItems: {
    invoiceItemId?: string;
    invoiceId?: string;
    productId?: string | null;
    productName?: string;
    unit?: any;
    sellingPrice: number;
    quantity: number;
    discounts?: number[] | null;
    discount?: number | null;
  }[],
  overallDiscount = 0,
  refundedAmount = 0,
  previousDueAmount = 0,
): CalculatedReturnTotals => {
  const credit = calculateReturnCreditFromItems(rawItems, overallDiscount);
  const previousDue = roundToTwo(Math.max(0, Number(previousDueAmount) || 0));
  const finalRefunded = roundToTwo(Math.max(0, Number(refundedAmount) || 0));
  const settleBase = roundToTwo(previousDue + credit.totalAmount);
  const dueRefundAmount = roundToTwo(Math.max(0, settleBase - finalRefunded));

  return {
    calculatedItems: credit.calculatedItems,
    subTotal: credit.subTotal,
    discount: credit.discount,
    totalAmount: credit.totalAmount,
    refundedAmount: finalRefunded,
    previousDueAmount: previousDue,
    dueRefundAmount,
  };
};

/** Alias used by existing call sites */
export const calculateReturnTotals = deriveReturnMoney;

export const getRefundOverCapMessage = (
  previousDueAmount: number,
  totalAmount: number,
  refundedAmount: number,
): string | null => {
  const cap = roundToTwo(Math.max(0, previousDueAmount) + Math.max(0, totalAmount));
  const refunded = roundToTwo(Math.max(0, refundedAmount));
  if (refunded > cap) {
    return `Refunded amount (৳${refunded.toFixed(2)}) cannot exceed previous due + net credit (৳${cap.toFixed(2)})`;
  }
  return null;
};

/**
 * Latest non-deleted return invoice for an invoice (LIFO tip).
 */
export const getLatestActiveReturn = async (
  prismaClient: any,
  invoiceId: string,
  args?: { include?: any; select?: any },
) => {
  return prismaClient.returnInvoice.findFirst({
    where: { invoiceId, isDeleted: false },
    orderBy: [{ createdAt: 'desc' }, { returnNumber: 'desc' }],
    ...(args?.include ? { include: args.include } : {}),
    ...(args?.select ? { select: args.select } : {}),
  });
};

export const isLatestActiveReturn = async (
  prismaClient: any,
  returnInvoice: { id: string; invoiceId: string; isDeleted?: boolean },
): Promise<boolean> => {
  if (returnInvoice.isDeleted) return false;
  const latest = await getLatestActiveReturn(prismaClient, returnInvoice.invoiceId, {
    select: { id: true },
  });
  return !!latest && latest.id === returnInvoice.id;
};

/** True when another active return exists on the same invoice created at/after this one. */
export const hasNewerActiveReturn = async (
  prismaClient: any,
  returnInvoice: { id: string; invoiceId: string; createdAt: Date },
): Promise<boolean> => {
  const count = await prismaClient.returnInvoice.count({
    where: {
      invoiceId: returnInvoice.invoiceId,
      isDeleted: false,
      id: { not: returnInvoice.id },
      createdAt: { gte: returnInvoice.createdAt },
    },
  });
  return count > 0;
};

/**
 * Aggregate already-returned quantities per invoiceItemId for an invoice.
 * Soft-deleted return invoices are excluded. Optionally exclude one return invoice (for edits).
 */
export const getReturnedQtyMap = async (
  prismaClient: any,
  invoiceId: string,
  excludeReturnInvoiceId?: string,
): Promise<Map<string, number>> => {
  const rows = await prismaClient.returnInvoiceItem.findMany({
    where: {
      invoiceId,
      returnInvoice: {
        isDeleted: false,
        ...(excludeReturnInvoiceId ? { id: { not: excludeReturnInvoiceId } } : {}),
      },
    },
    select: {
      invoiceItemId: true,
      quantity: true,
    },
  });

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(
      row.invoiceItemId,
      roundToTwo((map.get(row.invoiceItemId) || 0) + row.quantity),
    );
  }
  return map;
};

const moneyItemSelect = {
  sellingPrice: true,
  quantity: true,
  discounts: true,
  totalPrice: true,
} as const;

/**
 * Walk previousReturnInvoiceId chain and derive money from product lines.
 */
export const deriveMoneyForReturnInvoice = async (
  prismaClient: any,
  returnInvoiceId: string,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<DerivedReturnMoney> => {
  const cached = cache.get(returnInvoiceId);
  if (cached) return cached;

  const invoice = await prismaClient.returnInvoice.findUnique({
    where: { id: returnInvoiceId },
    select: {
      id: true,
      discount: true,
      refundedAmount: true,
      previousReturnInvoiceId: true,
      items: { select: moneyItemSelect },
    },
  });

  if (!invoice) {
    return {
      subTotal: 0,
      discount: 0,
      totalAmount: 0,
      refundedAmount: 0,
      previousDueAmount: 0,
      dueRefundAmount: 0,
    };
  }

  let previousDueAmount = 0;
  if (invoice.previousReturnInvoiceId) {
    const prevMoney = await deriveMoneyForReturnInvoice(
      prismaClient,
      invoice.previousReturnInvoiceId,
      cache,
    );
    previousDueAmount = prevMoney.dueRefundAmount;
  }

  const money = deriveReturnMoney(
    invoice.items,
    invoice.discount,
    invoice.refundedAmount,
    previousDueAmount,
  );

  const derived: DerivedReturnMoney = {
    subTotal: money.subTotal,
    discount: money.discount,
    totalAmount: money.totalAmount,
    refundedAmount: money.refundedAmount,
    previousDueAmount: money.previousDueAmount,
    dueRefundAmount: money.dueRefundAmount,
  };
  cache.set(returnInvoiceId, derived);
  return derived;
};

export const withDerivedReturnMoney = <T extends object>(
  invoice: T,
  money: DerivedReturnMoney,
): T & DerivedReturnMoney => ({
  ...invoice,
  ...money,
});

export interface InvoiceSettlement {
  invoiceTotal: number;
  paidAmount: number;
  creditsBefore: number;
  thisCredit: number;
  totalCredits: number;
  refundedBefore: number;
  thisRefunded: number;
  totalRefunded: number;
  /** Cash still held after cash refunds already given to the customer. */
  netPaid: number;
  netSaleAfterReturns: number;
  netDue: number;
  netRefundable: number;
}

/**
 * Invoice-level position after applying return credits and cash refunds.
 * Refunded cash reduces effective paid (money already returned to customer).
 * netDue = customer still owes; netRefundable = shop still owes customer.
 */
export const deriveInvoiceSettlement = (args: {
  invoiceTotal: number;
  paidAmount: number;
  creditsBefore?: number;
  thisCredit?: number;
  refundedBefore?: number;
  thisRefunded?: number;
}): InvoiceSettlement => {
  const invoiceTotal = roundToTwo(Math.max(0, Number(args.invoiceTotal) || 0));
  const paidAmount = roundToTwo(Math.max(0, Number(args.paidAmount) || 0));
  const creditsBefore = roundToTwo(Math.max(0, Number(args.creditsBefore) || 0));
  const thisCredit = roundToTwo(Math.max(0, Number(args.thisCredit) || 0));
  const refundedBefore = roundToTwo(Math.max(0, Number(args.refundedBefore) || 0));
  const thisRefunded = roundToTwo(Math.max(0, Number(args.thisRefunded) || 0));
  const totalCredits = roundToTwo(creditsBefore + thisCredit);
  const totalRefunded = roundToTwo(refundedBefore + thisRefunded);
  const netSaleAfterReturns = roundToTwo(Math.max(0, invoiceTotal - totalCredits));
  const netPaid = roundToTwo(Math.max(0, paidAmount - totalRefunded));
  const netDue = roundToTwo(Math.max(0, netSaleAfterReturns - netPaid));
  const netRefundable = roundToTwo(Math.max(0, netPaid - netSaleAfterReturns));

  return {
    invoiceTotal,
    paidAmount,
    creditsBefore,
    thisCredit,
    totalCredits,
    refundedBefore,
    thisRefunded,
    totalRefunded,
    netPaid,
    netSaleAfterReturns,
    netDue,
    netRefundable,
  };
};

type AncestorReturnMoneySum = { credits: number; refunded: number };

/**
 * Sum net credits + cash refunds for all ancestors in the previousReturnInvoiceId chain.
 */
export const sumAncestorReturnMoney = async (
  prismaClient: any,
  previousReturnInvoiceId: string | null | undefined,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<AncestorReturnMoneySum> => {
  if (!previousReturnInvoiceId) return { credits: 0, refunded: 0 };

  let credits = 0;
  let refunded = 0;
  let cursor: string | null = previousReturnInvoiceId;
  const visited = new Set<string>();

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const money = await deriveMoneyForReturnInvoice(prismaClient, cursor, cache);
    credits = roundToTwo(credits + money.totalAmount);
    refunded = roundToTwo(refunded + money.refundedAmount);
    const parent: { previousReturnInvoiceId: string | null } | null =
      await prismaClient.returnInvoice.findUnique({
        where: { id: cursor },
        select: { previousReturnInvoiceId: true },
      });
    cursor = parent?.previousReturnInvoiceId || null;
  }

  return { credits, refunded };
};

/** @deprecated Prefer sumAncestorReturnMoney — kept for existing call sites. */
export const sumAncestorReturnCredits = async (
  prismaClient: any,
  previousReturnInvoiceId: string | null | undefined,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<number> => {
  const sum = await sumAncestorReturnMoney(
    prismaClient,
    previousReturnInvoiceId,
    cache,
  );
  return sum.credits;
};

type ActiveReturnMoneySum = { credits: number; refunded: number };

/**
 * Sum net credits + cash refunds of all active returns on an invoice,
 * optionally excluding one (edit).
 */
export const sumActiveReturnMoneyOnInvoice = async (
  prismaClient: any,
  invoiceId: string,
  excludeReturnInvoiceId?: string,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<ActiveReturnMoneySum> => {
  const rows = await prismaClient.returnInvoice.findMany({
    where: {
      invoiceId,
      isDeleted: false,
      ...(excludeReturnInvoiceId ? { id: { not: excludeReturnInvoiceId } } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let credits = 0;
  let refunded = 0;
  for (const row of rows) {
    const money = await deriveMoneyForReturnInvoice(prismaClient, row.id, cache);
    credits = roundToTwo(credits + money.totalAmount);
    refunded = roundToTwo(refunded + money.refundedAmount);
  }
  return { credits, refunded };
};

/** @deprecated Prefer sumActiveReturnMoneyOnInvoice — kept for existing call sites. */
export const sumActiveReturnCreditsOnInvoice = async (
  prismaClient: any,
  invoiceId: string,
  excludeReturnInvoiceId?: string,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<number> => {
  const sum = await sumActiveReturnMoneyOnInvoice(
    prismaClient,
    invoiceId,
    excludeReturnInvoiceId,
    cache,
  );
  return sum.credits;
};

export const previousReturnSummarySelect = {
  id: true,
  returnNumber: true,
  discount: true,
  refundedAmount: true,
  createdAt: true,
  items: { select: moneyItemSelect },
} as const;
