/**
 * Round a number to two decimal places safely avoiding floating point artifacts
 */
export const roundToTwo = (num: number): number => {
  return Math.round((num + Number.EPSILON) * 100) / 100;
};

/**
 * Aggregate quantities by productId for stock adjustments.
 */
export const buildProductQtyMap = (
  items: { productId?: string | null; quantity: number }[],
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const item of items) {
    if (item.productId) {
      map.set(
        item.productId,
        roundToTwo((map.get(item.productId) || 0) + item.quantity),
      );
    }
  }
  return map;
};

/**
 * Adjust product stock by delta. Positive delta restores stock; negative deducts.
 * Never clamps to 0 — stock may go negative on oversell.
 */
export const adjustProductStock = async (
  tx: any,
  productId: string,
  delta: number,
  warnings: string[],
): Promise<void> => {
  if (delta === 0) return;

  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) return;

  const newStock = roundToTwo(product.stock + delta);

  if (delta < 0 && newStock < 0) {
    const deducted = Math.abs(delta);
    warnings.push(
      `Product "${product.name}" stock was insufficient (available: ${product.stock}, deducted: ${deducted}). Stock is now ${newStock}.`,
    );
  }

  await tx.product.update({
    where: { id: productId },
    data: { stock: newStock },
  });
};

/**
 * Apply a map of productId -> stock delta (positive restore, negative deduct).
 */
export const applyStockDeltaMap = async (
  tx: any,
  deltaMap: Map<string, number>,
  warnings: string[],
): Promise<void> => {
  for (const [productId, delta] of deltaMap.entries()) {
    await adjustProductStock(tx, productId, delta, warnings);
  }
};

/** Restore stock for receipt delete / return create (+qty). */
export const restoreStockForProductItems = async (
  tx: any,
  items: { productId?: string | null; quantity: number }[],
  warnings: string[],
): Promise<void> => {
  const qtyMap = buildProductQtyMap(items);
  for (const [productId, qty] of qtyMap.entries()) {
    await adjustProductStock(tx, productId, qty, warnings);
  }
};

/** Deduct stock for receipt create / restore receipt / return delete (-qty). */
export const deductStockForProductItems = async (
  tx: any,
  items: { productId?: string | null; quantity: number }[],
  warnings: string[],
): Promise<void> => {
  const qtyMap = buildProductQtyMap(items);
  for (const [productId, qty] of qtyMap.entries()) {
    await adjustProductStock(tx, productId, -qty, warnings);
  }
};

const DUPLICATE_PRODUCT_MESSAGE =
  'Duplicate product on receipt; each product can only appear once';

/**
 * Returns an error message if catalog productIds or custom product names
 * are duplicated within a receipt; otherwise null.
 * Custom names are compared trimmed and case-insensitive among items without productId.
 */
export const getReceiptItemsUniquenessError = (
  items: { productId?: string | null; productName?: string }[],
): string | null => {
  const seenProductIds = new Set<string>();
  const seenCustomNames = new Set<string>();

  for (const item of items) {
    if (item.productId) {
      if (seenProductIds.has(item.productId)) {
        return DUPLICATE_PRODUCT_MESSAGE;
      }
      seenProductIds.add(item.productId);
      continue;
    }

    const key = (item.productName || '').trim().toLowerCase();
    if (!key) continue;
    if (seenCustomNames.has(key)) {
      return DUPLICATE_PRODUCT_MESSAGE;
    }
    seenCustomNames.add(key);
  }

  return null;
};

export const getDuplicateReceiptProductMessage = () => DUPLICATE_PRODUCT_MESSAGE;

/**
 * Generate unique, monotonically increasing receipt number: REC-00000001
 * Sequence never resets and never repeats, even if previous receipts are deleted.
 */
export const generateReceiptNumber = async (prismaClient: any): Promise<string> => {
  const prefix = 'REC-';

  // Find all receipts starting with REC- (including isDeleted: true)
  const receipts = await prismaClient.receipt.findMany({
    where: {
      receiptNumber: {
        startsWith: prefix,
      },
    },
    select: {
      receiptNumber: true,
    },
  });

  let maxSeq = 0;
  for (const r of receipts) {
    if (!r.receiptNumber) continue;
    const match = r.receiptNumber.match(/^REC-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let candidate = `${prefix}${String(nextSeq).padStart(8, '0')}`;

  // Collision safety loop across all receipts (active or deleted)
  while (true) {
    const existing = await prismaClient.receipt.findFirst({
      where: { receiptNumber: candidate },
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

export interface CalculatedItem {
  productId?: string | null;
  productName: string;
  unit: any;
  sellingPrice: number;
  buyingPrice?: number | null;
  quantity: number;
  discount: number; // percentage e.g. 2.5
  totalPrice: number;
}

export interface CalculatedReceiptTotals {
  calculatedItems: CalculatedItem[];
  subTotal: number;
  discount: number;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
}

/**
 * Calculate individual item discounts (percentage) and overall receipt totals
 */
export const calculateReceiptTotals = (
  rawItems: {
    productId?: string | null;
    productName: string;
    unit?: any;
    sellingPrice: number;
    buyingPrice?: number | null;
    quantity: number;
    discount?: number;
  }[],
  overallDiscount = 0,
  paidAmount = 0,
): CalculatedReceiptTotals => {
  let subTotal = 0;

  const calculatedItems: CalculatedItem[] = rawItems.map(item => {
    const qty = Number(item.quantity);
    const unitPrice = Number(item.sellingPrice);
    const itemSubtotal = roundToTwo(qty * unitPrice);

    const discountPercent = Math.max(0, Math.min(100, Number(item.discount) || 0));
    const itemDiscountAmount = roundToTwo((itemSubtotal * discountPercent) / 100);
    const itemTotalPrice = roundToTwo(Math.max(0, itemSubtotal - itemDiscountAmount));

    subTotal = roundToTwo(subTotal + itemTotalPrice);

    return {
      productId: item.productId || null,
      productName: item.productName.trim(),
      unit: item.unit || 'PIECE',
      sellingPrice: unitPrice,
      buyingPrice: item.buyingPrice ?? null,
      quantity: qty,
      discount: discountPercent,
      totalPrice: itemTotalPrice,
    };
  });

  const finalDiscount = roundToTwo(Math.max(0, Number(overallDiscount) || 0));
  const totalAmount = roundToTwo(Math.max(0, subTotal - finalDiscount));
  const finalPaid = roundToTwo(Math.max(0, Number(paidAmount) || 0));
  const dueAmount = roundToTwo(Math.max(0, totalAmount - finalPaid));

  return {
    calculatedItems,
    subTotal,
    discount: finalDiscount,
    totalAmount,
    paidAmount: finalPaid,
    dueAmount,
  };
};
