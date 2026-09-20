import express from 'express';
import auth from '../../middlewares/auth';
import { StatsServices } from './stats.service';
import { DashboardStatsServices } from './stats.dashboard.service';

const router = express.Router();

router.get('/customers', auth('ANY'), StatsServices.getCustomerStats);

// Dashboard analytics (admin only)
const adminOnly = auth('SUPERADMIN', 'ADMIN');
router.get('/dashboard', adminOnly, DashboardStatsServices.getDashboardSummary);
router.get('/sales-performance', adminOnly, DashboardStatsServices.getSalesPerformance);
router.get('/profit-breakdown', adminOnly, DashboardStatsServices.getProfitBreakdown);
router.get('/low-stock', adminOnly, DashboardStatsServices.getLowStock);

export const StatsRouters = router;
