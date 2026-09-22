import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { prisma } from '../../utils/prisma';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../errors/AppError';
import {
  NotificationType,
  ProductUnit,
  ReceiptStatus,
  UserRoleEnum,
} from '../../../generated/prisma/client';
import { logActivity } from '../../utils/activityLog';
import { notifyAdmins, sendNotification } from '../../utils/notification';
import { productSearchableFields } from './product.constant';
import { generateSlug } from '../../utils/slug';
import { roundToTwo } from '../Receipt/receipt.utils';
import { parseProductProfitQuery } from './product.validation';
import {
  buildCreatedAtRange,
  contributeReceiptLine,
  emptyProductAgg,
  finalizeProductRow,
  sortProductProfitRows,
  summarizeProductProfit,
  type ProductProfitAgg,
} from './product.profit.utils';

const createProduct = catchAsync(async (req, res) => {
  const actor = req.user;
  const payload = req.body;
  const trimmedName = payload.name.trim();
  const slug = generateSlug(trimmedName);

  // Check for duplicate product by slug or case-insensitive name
  const existingProduct = await prisma.product.findFirst({
    where: {
      OR: [
        { slug },
        { name: { equals: trimmedName, mode: 'insensitive' } },
      ],
    },
  });

  if (existingProduct) {
    if (!existingProduct.isDeleted) {
      throw new AppError(
        httpStatus.CONFLICT,
        `A product with name "${trimmedName}" already exists and is active. Please use a different name or edit the existing product.`,
      );
    } else {
      throw new AppError(
        httpStatus.CONFLICT,
        `A product with name "${trimmedName}" already exists in deleted/trash items. Please restore it or choose a different name.`,
      );
    }
  }

  const product = await prisma.product.create({
    data: {
      name: trimmedName,
      slug,
      unit: payload.unit,
      sellingPrice: payload.sellingPrice,
      buyingPrice: payload.buyingPrice ?? null,
      stock: payload.stock ?? 0,
      description: payload.description ?? null,
      createdById: actor.id,
      updatedById: actor.id,
    },
    include: {
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  logActivity({
    userId: actor.id,
    action: 'CREATE_PRODUCT',
    entityType: 'PRODUCT',
    entityId: product.id,
    req,
    details: {
      name: product.name,
      sellingPrice: product.sellingPrice,
      buyingPrice: product.buyingPrice,
      unit: product.unit,
      stock: product.stock,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Product created successfully',
    data: product,
  });
});

const getAllProducts = catchAsync(async (req, res) => {
  const actor = req.user;
  const query: Record<string, unknown> = { ...req.query };

  // For cashiers, default isDeleted to false unless admin requests deleted items
  if (actor.role === UserRoleEnum.CASHIER || query.isDeleted === undefined) {
    query.isDeleted = false;
  } else if (query.isDeleted === 'true') {
    query.isDeleted = true;
  } else if (query.isDeleted === 'false') {
    query.isDeleted = false;
  }

  if (query.isDeleteRequested === 'true') {
    query.isDeleteRequested = true;
  } else if (query.isDeleteRequested === 'false') {
    query.isDeleteRequested = false;
  }

  const isLowStock = query.lowStock === 'true' || query.lowStock === true;
  delete query.lowStock;

  const stockStatus = query.stockStatus as string;
  delete query.stockStatus;

  const productsQuery = new QueryBuilder<typeof prisma.product>(
    prisma.product,
    query,
  );

  const isExportAll = String(query.limit || '').toLowerCase() === 'all';

  let productsQueryBuilder = productsQuery
    .search(productSearchableFields)
    .filter();

  if (stockStatus === 'NEGATIVE') {
    productsQueryBuilder = productsQueryBuilder.addWhere({
      stock: { lt: 0 },
    });
  } else if (stockStatus === 'OUT_OF_STOCK') {
    productsQueryBuilder = productsQueryBuilder.addWhere({
      stock: { equals: 0 },
    });
  } else if (stockStatus === 'CRITICAL') {
    productsQueryBuilder = productsQueryBuilder.addWhere({
      stock: { gt: 0, lte: 5 },
    });
  } else if (stockStatus === 'LOW') {
    productsQueryBuilder = productsQueryBuilder.addWhere({
      stock: { gt: 5, lte: 20 },
    });
  } else if (isLowStock) {
    productsQueryBuilder = productsQueryBuilder.addWhere({
      stock: { lte: 20 },
    });
  }

  productsQueryBuilder = productsQueryBuilder
    .sort()
    .customFields({
      id: true,
      name: true,
      slug: true,
      unit: true,
      sellingPrice: true,
      buyingPrice: true,
      stock: true,
      description: true,
      isDeleted: true,
      isDeleteRequested: true,
      deleteRequestedAt: true,
      deleteReason: true,
      createdAt: true,
      updatedAt: true,
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      updatedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      deleteRequestedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    });

  if (!isExportAll) {
    productsQueryBuilder = productsQueryBuilder.paginate();
  }

  const result = await productsQueryBuilder.execute();
  const data = result.data || [];

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Products retrieved successfully',
    ...result,
    data,
    meta: isExportAll
      ? {
          page: 1,
          limit: data.length,
          total: data.length,
          totalPage: 1,
        }
      : result.meta,
  });
});

/**
 * Active-catalog stats: product count, stock sum, net sold qty (receipts − returns).
 */
const getProductStats = catchAsync(async (_req, res) => {
  const [productAgg, soldAgg, returnedAgg, lowStockCount] = await Promise.all([
    prisma.product.aggregate({
      where: { isDeleted: false },
      _count: { _all: true },
      _sum: { stock: true },
    }),
    prisma.receiptItem.aggregate({
      where: {
        productId: { not: null },
        receipt: {
          isDeleted: false,
          status: { not: ReceiptStatus.REJECTED },
        },
      },
      _sum: { quantity: true },
    }),
    prisma.returnInvoiceItem.aggregate({
      where: {
        productId: { not: null },
        returnInvoice: {
          isDeleted: false,
          status: { not: ReceiptStatus.REJECTED },
        },
      },
      _sum: { quantity: true },
    }),
    prisma.product.count({
      where: {
        isDeleted: false,
        stock: { lte: 20 },
      },
    }),
  ]);

  const totalSoldRaw = Number(soldAgg._sum.quantity) || 0;
  const totalReturned = Number(returnedAgg._sum.quantity) || 0;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product stats retrieved successfully',
    data: {
      totalProducts: productAgg._count._all,
      totalStock: roundToTwo(Number(productAgg._sum.stock) || 0),
      totalSoldQty: roundToTwo(Math.max(0, totalSoldRaw - totalReturned)),
      lowStockCount,
    },
  });
});

const getProductById = catchAsync(async (req, res) => {
  const { id } = req.params;

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      updatedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      deleteRequestedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  if (!product) {
    throw new AppError(httpStatus.NOT_FOUND, 'Product not found');
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product retrieved successfully',
    data: product,
  });
});

const updateProduct = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const payload = req.body;

  const existing = await prisma.product.findUnique({
    where: { id },
  });

  if (!existing || existing.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Product not found');
  }

  let slugToUpdate: string | undefined;

  if (payload.name) {
    const trimmedName = payload.name.trim();
    const newSlug = generateSlug(trimmedName);

    // Check if another product already uses this slug or name
    const duplicate = await prisma.product.findFirst({
      where: {
        id: { not: id },
        OR: [
          { slug: newSlug },
          { name: { equals: trimmedName, mode: 'insensitive' } },
        ],
      },
    });

    if (duplicate) {
      if (!duplicate.isDeleted) {
        throw new AppError(
          httpStatus.CONFLICT,
          `A product with name "${trimmedName}" already exists and is active. Please choose a different name.`,
        );
      } else {
        throw new AppError(
          httpStatus.CONFLICT,
          `A product with name "${trimmedName}" already exists in deleted/trash items. Please restore it or choose a different name.`,
        );
      }
    }

    slugToUpdate = newSlug;
  } else if (!existing.slug && existing.name) {
    // Backfill slug for legacy products when modified
    slugToUpdate = generateSlug(existing.name);
  }

  const updatedProduct = await prisma.product.update({
    where: { id },
    data: {
      ...payload,
      ...(payload.name ? { name: payload.name.trim() } : {}),
      ...(slugToUpdate ? { slug: slugToUpdate } : {}),
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'UPDATE_PRODUCT',
    entityType: 'PRODUCT',
    entityId: id,
    req,
    details: {
      name: updatedProduct.name,
      sellingPrice: updatedProduct.sellingPrice,
      buyingPrice: updatedProduct.buyingPrice,
      stock: updatedProduct.stock,
      unit: updatedProduct.unit,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product updated successfully',
    data: updatedProduct,
  });
});

/**
 * Delete product handler with multi-role confirmation flow:
 * - Admin/Superadmin: Soft-deletes immediately (isDeleted: true).
 * - Cashier: Submits delete request (isDeleteRequested: true) and alerts admins.
 */
const deleteProduct = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const { reason } = req.body || {};

  const product = await prisma.product.findUnique({
    where: { id },
  });

  if (!product || product.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Product not found');
  }

  const isAdmin = actor.role === UserRoleEnum.SUPERADMIN || actor.role === UserRoleEnum.ADMIN;

  if (isAdmin) {
    // Immediate soft delete by Admin
    const result = await prisma.product.update({
      where: { id },
      data: {
        isDeleted: true,
        isDeleteRequested: false,
        updatedById: actor.id,
      },
    });

    logActivity({
      userId: actor.id,
      action: 'ADMIN_DELETE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: id,
      req,
      details: { name: product.name },
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Product deleted successfully',
      data: result,
    });
  } else {
    // Cashier delete request -> Pending Admin Confirmation
    if (product.isDeleteRequested) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Deletion request is already pending admin confirmation',
      );
    }

    const result = await prisma.product.update({
      where: { id },
      data: {
        isDeleteRequested: true,
        deleteRequestedById: actor.id,
        deleteRequestedAt: new Date(),
        deleteReason: reason || null,
        updatedById: actor.id,
      },
    });

    logActivity({
      userId: actor.id,
      action: 'REQUEST_DELETE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: id,
      req,
      details: { name: product.name, reason },
    });

    // Notify all admins about the pending request
    notifyAdmins({
      title: 'Product Deletion Requested',
      message: `${actor.name || 'Cashier'} requested to delete product "${product.name}".`,
      type: NotificationType.WARNING,
      link: '/products',
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Product deletion request submitted to admin for confirmation',
      data: result,
    });
  }
});

/**
 * Confirm delete request (Admin only)
 */
const confirmDeleteProduct = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const product = await prisma.product.findUnique({
    where: { id },
  });

  if (!product || product.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Product not found');
  }

  const result = await prisma.product.update({
    where: { id },
    data: {
      isDeleted: true,
      isDeleteRequested: false,
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_CONFIRM_DELETE_PRODUCT',
    entityType: 'PRODUCT',
    entityId: id,
    req,
    details: { name: product.name, requestedBy: product.deleteRequestedById },
  });

  // Notify the cashier who requested the deletion
  if (product.deleteRequestedById) {
    sendNotification({
      userId: product.deleteRequestedById,
      title: 'Product Deletion Approved',
      message: `Your request to delete "${product.name}" was approved by administrator.`,
      type: NotificationType.SUCCESS,
      link: '/products',
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product deletion confirmed successfully',
    data: result,
  });
});

/**
 * Reject delete request (Admin only)
 */
const rejectDeleteProduct = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const product = await prisma.product.findUnique({
    where: { id },
  });

  if (!product || product.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Product not found');
  }

  const result = await prisma.product.update({
    where: { id },
    data: {
      isDeleteRequested: false,
      deleteRequestedById: null,
      deleteRequestedAt: null,
      deleteReason: null,
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_REJECT_DELETE_PRODUCT',
    entityType: 'PRODUCT',
    entityId: id,
    req,
    details: { name: product.name, requestedBy: product.deleteRequestedById },
  });

  if (product.deleteRequestedById) {
    sendNotification({
      userId: product.deleteRequestedById,
      title: 'Product Deletion Rejected',
      message: `Your request to delete "${product.name}" was rejected by administrator.`,
      type: NotificationType.WARNING,
      link: '/products',
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product deletion request rejected',
    data: result,
  });
});

/**
 * Restore soft-deleted product (Undo - Admin only)
 */
const restoreProduct = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;

  const product = await prisma.product.findUnique({
    where: { id },
  });

  if (!product) {
    throw new AppError(httpStatus.NOT_FOUND, 'Product not found');
  }

  if (!product.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Product is not deleted');
  }

  const result = await prisma.product.update({
    where: { id },
    data: {
      isDeleted: false,
      isDeleteRequested: false,
      updatedById: actor.id,
    },
  });

  logActivity({
    userId: actor.id,
    action: 'ADMIN_RESTORE_PRODUCT',
    entityType: 'PRODUCT',
    entityId: id,
    req,
    details: { name: product.name },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product restored successfully',
    data: result,
  });
});

interface IBulkProductItem {
  name: string;
  unit: ProductUnit;
  sellingPrice: number;
  buyingPrice?: number | null;
  stock?: number;
  description?: string | null;
}

const bulkCreateProducts = catchAsync(async (req, res) => {
  const actor = req.user;
  const { products } = req.body as { products: IBulkProductItem[] };

  // 1. Check internal duplicates within the batch by trimmed lowercase name and slug
  const seenSlugs = new Set<string>();
  const seenNames = new Set<string>();

  for (const item of products) {
    const trimmedName = item.name.trim();
    const lowerName = trimmedName.toLowerCase();
    const slug = generateSlug(trimmedName);

    if (seenNames.has(lowerName) || seenSlugs.has(slug)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Duplicate product name "${trimmedName}" found multiple times in your upload list. Please remove or rename duplicates.`,
      );
    }
    seenNames.add(lowerName);
    seenSlugs.add(slug);
  }

  // 2. Query database for existing products with any of these slugs or names
  const allSlugs = Array.from(seenSlugs);
  const allNames = products.map((p) => p.name.trim());

  const existingProducts = await prisma.product.findMany({
    where: {
      OR: [
        { slug: { in: allSlugs } },
        { name: { in: allNames, mode: 'insensitive' } },
      ],
    },
  });

  // Check for conflicts with active products
  const activeConflicts = existingProducts.filter((p) => !p.isDeleted);
  if (activeConflicts.length > 0) {
    const conflictNames = activeConflicts.map((p) => `"${p.name}"`).join(', ');
    throw new AppError(
      httpStatus.CONFLICT,
      `Product ${conflictNames} already exist(s) and is currently active. Please use different name(s) or edit existing product(s).`,
    );
  }

  // Build a map of deleted products to restore
  const deletedMap = new Map<string, typeof existingProducts[0]>();
  for (const dp of existingProducts.filter((p) => p.isDeleted)) {
    if (dp.slug) deletedMap.set(dp.slug, dp);
    deletedMap.set(dp.name.trim().toLowerCase(), dp);
  }

  // 3. Execute in transaction: restore/update soft-deleted products, create new products
  const result = await prisma.$transaction(async (tx) => {
    const createdOrUpdatedList = [];

    for (const item of products) {
      const trimmedName = item.name.trim();
      const slug = generateSlug(trimmedName);
      const lowerName = trimmedName.toLowerCase();

      const existingDeleted = deletedMap.get(slug) || deletedMap.get(lowerName);

      if (existingDeleted) {
        // Restore and update with new details
        const restored = await tx.product.update({
          where: { id: existingDeleted.id },
          data: {
            name: trimmedName,
            slug,
            unit: item.unit,
            sellingPrice: item.sellingPrice,
            buyingPrice: item.buyingPrice ?? null,
            stock: item.stock ?? 0,
            description: item.description ?? null,
            isDeleted: false,
            isDeleteRequested: false,
            deleteRequestedById: null,
            deleteRequestedAt: null,
            deleteReason: null,
            updatedById: actor.id,
          },
        });
        createdOrUpdatedList.push(restored);
      } else {
        // Create new
        const created = await tx.product.create({
          data: {
            name: trimmedName,
            slug,
            unit: item.unit,
            sellingPrice: item.sellingPrice,
            buyingPrice: item.buyingPrice ?? null,
            stock: item.stock ?? 0,
            description: item.description ?? null,
            createdById: actor.id,
            updatedById: actor.id,
          },
        });
        createdOrUpdatedList.push(created);
      }
    }

    return createdOrUpdatedList;
  });

  // Non-blocking activity log
  logActivity({
    userId: actor.id,
    action: 'CREATE_PRODUCT',
    entityType: 'PRODUCT',
    req,
    details: {
      type: 'BULK_IMPORT',
      totalCount: result.length,
      productNames: result.map((p) => p.name),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: `Successfully processed ${result.length} products`,
    data: result,
  });
});

/**
 * Per-product profit/loss from receipt items in an optional date range.
 *
 * Date rules (Asia/Dhaka calendar days, inclusive):
 * - Only receipts whose createdAt falls in [startDate, endDate]
 * - Returned qty deducted only from return invoices whose createdAt is also in range
 * - Returns outside the range are ignored (net sold stays higher for that period)
 *
 * Profit uses receipt-item selling (via totalPrice) and buyingPrice snapshots.
 * If buyingPrice is missing, unit sellingPrice is used as cost (zero margin on that qty).
 * Return unit-price differences are ignored — only qty is reduced.
 * Each product row includes receipt numbers that contributed net sold qty.
 */
const getProductProfit = catchAsync(async (req, res) => {
  const query = parseProductProfitQuery(req.query);
  const createdAtRange = buildCreatedAtRange(query.startDate, query.endDate);

  const receiptWhere = {
    isDeleted: false,
    status: { not: ReceiptStatus.REJECTED },
    ...(createdAtRange ? { createdAt: createdAtRange } : {}),
  };

  const receipts = await prisma.receipt.findMany({
    where: receiptWhere,
    select: {
      id: true,
      receiptNumber: true,
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
          product: {
            select: {
              id: true,
              name: true,
              unit: true,
            },
          },
        },
      },
    },
  });

  const receiptItems = receipts.flatMap(r =>
    r.items.map(item => ({
      ...item,
      receiptId: r.id,
      receiptNumber: r.receiptNumber,
    })),
  );
  const receiptItemIds = receiptItems.map(it => it.id);

  const returnedQtyByItemId = new Map<string, number>();

  if (receiptItemIds.length > 0) {
    const returnRows = await prisma.returnInvoiceItem.findMany({
      where: {
        receiptItemId: { in: receiptItemIds },
        returnInvoice: {
          isDeleted: false,
          status: { not: ReceiptStatus.REJECTED },
          ...(createdAtRange ? { createdAt: createdAtRange } : {}),
        },
      },
      select: {
        receiptItemId: true,
        quantity: true,
      },
    });

    for (const row of returnRows) {
      returnedQtyByItemId.set(
        row.receiptItemId,
        roundToTwo(
          (returnedQtyByItemId.get(row.receiptItemId) || 0) + Number(row.quantity),
        ),
      );
    }
  }

  const byProduct = new Map<string, ProductProfitAgg>();

  for (const item of receiptItems) {
    const productId = item.productId;
    if (!productId) continue;

    const name = item.product?.name || item.productName;
    const unit = item.product?.unit || 'PIECE';

    let agg = byProduct.get(productId);
    if (!agg) {
      agg = emptyProductAgg(productId, name, unit);
      byProduct.set(productId, agg);
    } else if (item.product?.name) {
      agg.productName = item.product.name;
      agg.unit = item.product.unit;
    }

    contributeReceiptLine(
      agg,
      {
        quantity: item.quantity,
        totalPrice: item.totalPrice,
        sellingPrice: item.sellingPrice,
        buyingPrice: item.buyingPrice,
      },
      returnedQtyByItemId.get(item.id) || 0,
      { id: item.receiptId, receiptNumber: item.receiptNumber },
    );
  }

  let rows = Array.from(byProduct.values())
    .map(finalizeProductRow)
    .filter(row => row.soldQty > 0);

  if (query.searchTerm) {
    const term = query.searchTerm.toLowerCase();
    rows = rows.filter(row => row.productName.toLowerCase().includes(term));
  }

  rows = sortProductProfitRows(rows, query.sortBy, query.sortOrder);

  const summary = summarizeProductProfit(rows);

  const total = rows.length;
  const page = query.page;
  const limit = query.limit;
  const totalPage = total === 0 ? 0 : Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paged = rows.slice(start, start + limit);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Product profit report retrieved successfully',
    meta: {
      page,
      limit,
      total,
      totalPage,
    },
    data: {
      products: paged,
      summary,
      filters: {
        startDate: query.startDate ?? null,
        endDate: query.endDate ?? null,
        searchTerm: query.searchTerm ?? null,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        timezone: 'Asia/Dhaka',
      },
    },
  });
});

export const ProductServices = {
  createProduct,
  bulkCreateProducts,
  getAllProducts,
  getProductStats,
  getProductById,
  getProductProfit,
  updateProduct,
  deleteProduct,
  confirmDeleteProduct,
  rejectDeleteProduct,
  restoreProduct,
};
