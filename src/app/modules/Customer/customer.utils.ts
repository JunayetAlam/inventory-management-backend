import { roundToTwo } from '../Invoice/invoice.utils';
import {
  deriveInvoiceSettlement,
  deriveReturnMoney,
} from '../ReturnInvoice/returnInvoice.utils';

export type CustomerFinancials = {
  totalDue: number;
  totalPaid: number;
  totalDiscount: number;
  totalRefunded: number;
  totalRefundDue: number;
};

const emptyFinancials = (): CustomerFinancials => ({
  totalDue: 0,
  totalPaid: 0,
  totalDiscount: 0,
  totalRefunded: 0,
  totalRefundDue: 0,
});

type ReturnItemRow = {
  sellingPrice: number;
  quantity: number;
  discounts: number[];
  totalPrice: number;
};

type ReturnRow = {
  id: string;
  discount: number;
  refundedAmount: number;
  previousReturnInvoiceId: string | null;
  createdAt: Date;
  returnNumber: string;
  items: ReturnItemRow[];
};

type InvoiceRow = {
  customerId: string;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  discount: number;
  returnInvoices: ReturnRow[];
};

const moneyItemSelect = {
  sellingPrice: true,
  quantity: true,
  discounts: true,
  totalPrice: true,
} as const;

/**
 * Active return chain from root → tip, skipping deleted parents not in the loaded set.
 */
const buildActiveChain = (
  latest: ReturnRow,
  byId: Map<string, ReturnRow>,
): ReturnRow[] => {
  const fromTip: ReturnRow[] = [];
  const visited = new Set<string>();
  let cursor: ReturnRow | undefined = latest;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    fromTip.push(cursor);
    const parentId: string | null = cursor.previousReturnInvoiceId;
    cursor = parentId ? byId.get(parentId) : undefined;
  }

  return fromTip.reverse();
};

/**
 * Live totals for one invoice: last return invoice currentPosition when returns exist,
 * otherwise stored invoice due/paid/discount.
 */
export const computeInvoiceLiveTotals = (invoice: InvoiceRow) => {
  const returns = invoice.returnInvoices || [];
  if (!returns.length) {
    return {
      due: roundToTwo(invoice.dueAmount),
      paid: roundToTwo(invoice.paidAmount),
      discount: roundToTwo(invoice.discount),
      refunded: 0,
      refundDue: 0,
    };
  }

  const byId = new Map(returns.map(row => [row.id, row]));
  const latest = returns[0];
  const chain = buildActiveChain(latest, byId);

  let previousDue = 0;
  let ancestorCredits = 0;
  let ancestorRefunded = 0;
  let chainDiscount = 0;
  let thisMoney = deriveReturnMoney(
    latest.items,
    latest.discount,
    latest.refundedAmount,
    0,
  );

  for (let i = 0; i < chain.length; i++) {
    const row = chain[i];
    const money = deriveReturnMoney(
      row.items,
      row.discount,
      row.refundedAmount,
      previousDue,
    );
    chainDiscount = roundToTwo(chainDiscount + money.discount);
    if (i < chain.length - 1) {
      ancestorCredits = roundToTwo(ancestorCredits + money.totalAmount);
      ancestorRefunded = roundToTwo(ancestorRefunded + money.refundedAmount);
      previousDue = money.dueRefundAmount;
    } else {
      thisMoney = money;
    }
  }

  const settlement = deriveInvoiceSettlement({
    invoiceTotal: invoice.totalAmount,
    paidAmount: invoice.paidAmount,
    creditsBefore: ancestorCredits,
    thisCredit: thisMoney.totalAmount,
    refundedBefore: ancestorRefunded,
    thisRefunded: thisMoney.refundedAmount,
  });

  return {
    due: roundToTwo(settlement.netDue - settlement.netRefundable),
    paid: roundToTwo(invoice.paidAmount),
    discount: roundToTwo(roundToTwo(invoice.discount) + chainDiscount),
    refunded: settlement.totalRefunded,
    refundDue: settlement.netRefundable,
  };
};

/**
 * Aggregate live invoice/return totals for the given customers.
 * Soft-deleted invoices and return invoices are excluded.
 */
export const computeCustomersFinancials = async (
  prismaClient: any,
  customerIds: string[],
): Promise<Map<string, CustomerFinancials>> => {
  const map = new Map<string, CustomerFinancials>();
  for (const id of customerIds) {
    map.set(id, emptyFinancials());
  }

  if (!customerIds.length) return map;

  const invoices: InvoiceRow[] = await prismaClient.invoice.findMany({
    where: {
      customerId: { in: customerIds },
      isDeleted: false,
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
          items: { select: moneyItemSelect },
        },
        orderBy: [{ createdAt: 'desc' }, { returnNumber: 'desc' }],
      },
    },
  });

  for (const invoice of invoices) {
    const totals = computeInvoiceLiveTotals(invoice);
    const current = map.get(invoice.customerId) || emptyFinancials();
    map.set(invoice.customerId, {
      totalDue: roundToTwo(current.totalDue + totals.due),
      totalPaid: roundToTwo(current.totalPaid + totals.paid),
      totalDiscount: roundToTwo(current.totalDiscount + totals.discount),
      totalRefunded: roundToTwo(current.totalRefunded + totals.refunded),
      totalRefundDue: roundToTwo(current.totalRefundDue + totals.refundDue),
    });
  }

  return map;
};

export const attachCustomerFinancials = <T extends { id: string }>(
  customers: T[],
  financials: Map<string, CustomerFinancials>,
): (T & CustomerFinancials)[] =>
  customers.map(customer => ({
    ...customer,
    ...(financials.get(customer.id) || emptyFinancials()),
  }));

/**
 * Sum signed live dues for the given customers (same math as the customer table).
 */
export const sumCustomersSignedDue = async (
  prismaClient: any,
  customerIds: string[],
): Promise<number> => {
  const financials = await computeCustomersFinancials(prismaClient, customerIds);
  let totalDue = 0;
  for (const row of financials.values()) {
    totalDue = roundToTwo(totalDue + row.totalDue);
  }
  return totalDue;
};
