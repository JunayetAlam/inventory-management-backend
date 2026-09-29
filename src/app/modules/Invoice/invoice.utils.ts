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

/** Restore stock for invoice delete / return create (+qty). */
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

/** Deduct stock for invoice create / restore invoice / return delete (-qty). */
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
  'Duplicate product on invoice; each product can only appear once';

/**
 * Returns an error message if catalog productIds or custom product names
 * are duplicated within an invoice; otherwise null.
 * Custom names are compared trimmed and case-insensitive among items without productId.
 */
export const getInvoiceItemsUniquenessError = (
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

export const getDuplicateInvoiceProductMessage = () => DUPLICATE_PRODUCT_MESSAGE;

export const areInvoiceItemsChanged = (
  existingItems: {
    productId?: string | null;
    productName: string;
    unit: any;
    sellingPrice: number;
    quantity: number;
    discounts?: number[];
  }[],
  newItems: {
    productId?: string | null;
    productName: string;
    unit?: any;
    sellingPrice: number;
    quantity: number;
    discounts?: number[];
  }[],
): boolean => {
  if (existingItems.length !== newItems.length) return true;
  for (let i = 0; i < existingItems.length; i++) {
    const oldIt = existingItems[i];
    const newIt = newItems[i];
    if ((oldIt.productId || null) !== (newIt.productId || null)) return true;
    if ((oldIt.productName || '').trim().toLowerCase() !== (newIt.productName || '').trim().toLowerCase()) return true;
    if (oldIt.unit !== (newIt.unit || 'PIECE')) return true;
    if (roundToTwo(Number(oldIt.sellingPrice)) !== roundToTwo(Number(newIt.sellingPrice))) return true;
    if (roundToTwo(Number(oldIt.quantity)) !== roundToTwo(Number(newIt.quantity))) return true;

    const oldDiscounts = (oldIt.discounts || []).map(Number).filter(d => d > 0);
    const newDiscounts = (newIt.discounts || []).map(Number).filter(d => d > 0);
    if (oldDiscounts.length !== newDiscounts.length) return true;
    for (let j = 0; j < oldDiscounts.length; j++) {
      if (roundToTwo(oldDiscounts[j]) !== roundToTwo(newDiscounts[j])) return true;
    }
  }
  return false;
};

/**
 * Generate unique, monotonically increasing invoice number: REC-00000001
 * Sequence never resets and never repeats, even if previous invoices are deleted.
 */
export const generateInvoiceNumber = async (prismaClient: any): Promise<string> => {
  const prefix = 'REC-';

  // Find all invoices starting with REC- (including isDeleted: true)
  const invoices = await prismaClient.invoice.findMany({
    where: {
      invoiceNumber: {
        startsWith: prefix,
      },
    },
    select: {
      invoiceNumber: true,
    },
  });

  let maxSeq = 0;
  for (const r of invoices) {
    if (!r.invoiceNumber) continue;
    const match = r.invoiceNumber.match(/^REC-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let candidate = `${prefix}${String(nextSeq).padStart(8, '0')}`;

  // Collision safety loop across all invoices (active or deleted)
  while (true) {
    const existing = await prismaClient.invoice.findFirst({
      where: { invoiceNumber: candidate },
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
  discounts: number[];
  totalPrice: number;
}

export interface CalculatedInvoiceTotals {
  calculatedItems: CalculatedItem[];
  subTotal: number;
  discount: number;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
}

/**
 * Calculate individual item discounts (percentage) and overall invoice totals
 */
export const calculateInvoiceTotals = (
  rawItems: {
    productId?: string | null;
    productName: string;
    unit?: any;
    sellingPrice: number;
    buyingPrice?: number | null;
    quantity: number;
    discounts?: number[];
    discount?: number;
  }[],
  overallDiscount = 0,
  paidAmount = 0,
): CalculatedInvoiceTotals => {
  let subTotal = 0;

  const calculatedItems: CalculatedItem[] = rawItems.map(item => {
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
      productId: item.productId || null,
      productName: item.productName.trim(),
      unit: item.unit || 'PIECE',
      sellingPrice: unitPrice,
      buyingPrice: item.buyingPrice ?? null,
      quantity: qty,
      discounts: sanitizedDiscounts,
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
