import express from 'express';
import { UserRouters } from '../modules/User/user.routes';
import { AssetRouters } from '../modules/Asset/asset.route';
import { AuthByOtpRouters } from '../modules/AuthByOtp/auth.routes';

import { NotificationRouters } from '../modules/Notification/notification.routes';
import { ActivityLogRouters } from '../modules/ActivityLog/activityLog.routes';
import { CustomerTransactionRouters } from '../modules/CustomerTransaction/customerTransaction.routes';
import { ProductRouters } from '../modules/Product/product.routes';
import { CustomerRouters } from '../modules/Customer/customer.routes';
import { InvoiceRouters } from '../modules/Invoice/invoice.routes';
import { ReturnInvoiceRouters } from '../modules/ReturnInvoice/returnInvoice.routes';
import { ShopRouters } from '../modules/Shop/shop.routes';
import { StatsRouters } from '../modules/Stats/stats.routes';

const router = express.Router();

const moduleRoutes = [
  {
    path: '/auth',
    route: AuthByOtpRouters,
  },
  {
    path: '/users',
    route: UserRouters,
  },
  {
    path: '/customers',
    route: CustomerRouters,
  },
  {
    path: '/customer-transactions',
    route: CustomerTransactionRouters,
  },
  {
    path: '/products',
    route: ProductRouters,
  },
  {
    path: '/invoices',
    route: InvoiceRouters,
  },
  {
    path: '/return-invoices',
    route: ReturnInvoiceRouters,
  },
  {
    path: '/shops',
    route: ShopRouters,
  },
  {
    path: '/stats',
    route: StatsRouters,
  },
  {
    path: '/assets',
    route: AssetRouters,
  },
  {
    path: '/notifications',
    route: NotificationRouters,
  },
  {
    path: '/activity-logs',
    route: ActivityLogRouters,
  },
];

moduleRoutes.forEach(route => router.use(route.path, route.route));

export default router;
