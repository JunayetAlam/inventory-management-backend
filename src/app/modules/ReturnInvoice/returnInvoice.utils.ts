import { roundToTwo } from '../Receipt/receipt.utils';

const DUPLICATE_RECEIPT_ITEM_MESSAGE =
  'Duplicate receipt item on return invoice; each source line can only appear once';

export const getDuplicateReturnItemMessage = () => DUPLICATE_RECEIPT_ITEM_MESSAGE;

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
  items: { receiptItemId: string }[],
): string | null => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.receiptItemId)) {
      return DUPLICATE_RECEIPT_ITEM_MESSAGE;
    }
    seen.add(item.receiptItemId);
  }
  return null;
};

export interface CalculatedReturnItem {
  receiptItemId: string;
  receiptId: string;
  productId: string | null;
  productName: string;
  unit: any;
  sellingPrice: number;
  quantity: number;
  discount: number;
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
    receiptItemId?: string;
    receiptId?: string;
    productId?: string | null;
    productName?: string;
    unit?: any;
    sellingPrice: number;
    quantity: number;
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

    const discountPercent = Math.max(0, Math.min(100, Number(item.discount) || 0));
    const itemDiscountAmount = roundToTwo((itemSubtotal * discountPercent) / 100);
    const itemTotalPrice = roundToTwo(Math.max(0, itemSubtotal - itemDiscountAmount));

    subTotal = roundToTwo(subTotal + itemTotalPrice);

    return {
      receiptItemId: item.receiptItemId || '',
      receiptId: item.receiptId || '',
      productId: item.productId || null,
      productName: (item.productName || '').trim(),
      unit: item.unit || 'PIECE',
      sellingPrice: unitPrice,
      quantity: qty,
      discount: discountPercent,
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
    receiptItemId?: string;
    receiptId?: string;
    productId?: string | null;
    productName?: string;
    unit?: any;
    sellingPrice: number;
    quantity: number;
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
 * Latest non-deleted return invoice for a receipt (LIFO tip).
 */
export const getLatestActiveReturn = async (
  prismaClient: any,
  receiptId: string,
  args?: { include?: any; select?: any },
) => {
  return prismaClient.returnInvoice.findFirst({
    where: { receiptId, isDeleted: false },
    orderBy: [{ createdAt: 'desc' }, { returnNumber: 'desc' }],
    ...(args?.include ? { include: args.include } : {}),
    ...(args?.select ? { select: args.select } : {}),
  });
};

export const isLatestActiveReturn = async (
  prismaClient: any,
  returnInvoice: { id: string; receiptId: string; isDeleted?: boolean },
): Promise<boolean> => {
  if (returnInvoice.isDeleted) return false;
  const latest = await getLatestActiveReturn(prismaClient, returnInvoice.receiptId, {
    select: { id: true },
  });
  return !!latest && latest.id === returnInvoice.id;
};

/** True when another active return exists on the same receipt created at/after this one. */
export const hasNewerActiveReturn = async (
  prismaClient: any,
  returnInvoice: { id: string; receiptId: string; createdAt: Date },
): Promise<boolean> => {
  const count = await prismaClient.returnInvoice.count({
    where: {
      receiptId: returnInvoice.receiptId,
      isDeleted: false,
      id: { not: returnInvoice.id },
      createdAt: { gte: returnInvoice.createdAt },
    },
  });
  return count > 0;
};

/**
 * Aggregate already-returned quantities per receiptItemId for a receipt.
 * Soft-deleted return invoices are excluded. Optionally exclude one return invoice (for edits).
 */
export const getReturnedQtyMap = async (
  prismaClient: any,
  receiptId: string,
  excludeReturnInvoiceId?: string,
): Promise<Map<string, number>> => {
  const rows = await prismaClient.returnInvoiceItem.findMany({
    where: {
      receiptId,
      returnInvoice: {
        isDeleted: false,
        ...(excludeReturnInvoiceId ? { id: { not: excludeReturnInvoiceId } } : {}),
      },
    },
    select: {
      receiptItemId: true,
      quantity: true,
    },
  });

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(
      row.receiptItemId,
      roundToTwo((map.get(row.receiptItemId) || 0) + row.quantity),
    );
  }
  return map;
};

const moneyItemSelect = {
  sellingPrice: true,
  quantity: true,
  discount: true,
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

export interface ReceiptSettlement {
  receiptTotal: number;
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
 * Receipt-level position after applying return credits and cash refunds.
 * Refunded cash reduces effective paid (money already returned to customer).
 * netDue = customer still owes; netRefundable = shop still owes customer.
 */
export const deriveReceiptSettlement = (args: {
  receiptTotal: number;
  paidAmount: number;
  creditsBefore?: number;
  thisCredit?: number;
  refundedBefore?: number;
  thisRefunded?: number;
}): ReceiptSettlement => {
  const receiptTotal = roundToTwo(Math.max(0, Number(args.receiptTotal) || 0));
  const paidAmount = roundToTwo(Math.max(0, Number(args.paidAmount) || 0));
  const creditsBefore = roundToTwo(Math.max(0, Number(args.creditsBefore) || 0));
  const thisCredit = roundToTwo(Math.max(0, Number(args.thisCredit) || 0));
  const refundedBefore = roundToTwo(Math.max(0, Number(args.refundedBefore) || 0));
  const thisRefunded = roundToTwo(Math.max(0, Number(args.thisRefunded) || 0));
  const totalCredits = roundToTwo(creditsBefore + thisCredit);
  const totalRefunded = roundToTwo(refundedBefore + thisRefunded);
  const netSaleAfterReturns = roundToTwo(Math.max(0, receiptTotal - totalCredits));
  const netPaid = roundToTwo(Math.max(0, paidAmount - totalRefunded));
  const netDue = roundToTwo(Math.max(0, netSaleAfterReturns - netPaid));
  const netRefundable = roundToTwo(Math.max(0, netPaid - netSaleAfterReturns));

  return {
    receiptTotal,
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
 * Sum net credits + cash refunds of all active returns on a receipt,
 * optionally excluding one (edit).
 */
export const sumActiveReturnMoneyOnReceipt = async (
  prismaClient: any,
  receiptId: string,
  excludeReturnInvoiceId?: string,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<ActiveReturnMoneySum> => {
  const rows = await prismaClient.returnInvoice.findMany({
    where: {
      receiptId,
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

/** @deprecated Prefer sumActiveReturnMoneyOnReceipt — kept for existing call sites. */
export const sumActiveReturnCreditsOnReceipt = async (
  prismaClient: any,
  receiptId: string,
  excludeReturnInvoiceId?: string,
  cache: Map<string, DerivedReturnMoney> = new Map(),
): Promise<number> => {
  const sum = await sumActiveReturnMoneyOnReceipt(
    prismaClient,
    receiptId,
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
