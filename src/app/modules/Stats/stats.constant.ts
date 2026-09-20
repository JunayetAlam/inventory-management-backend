export const LOW_STOCK_THRESHOLD = 5;
export const DASHBOARD_TZ = 'Asia/Dhaka';
export const DASHBOARD_TZ_OFFSET = '+06:00';
/** Dhaka is UTC+6 with no DST. */
export const DASHBOARD_TZ_OFFSET_MS = 6 * 60 * 60 * 1000;
export const DASHBOARD_PRESETS = ['today', 'week', 'month', 'all', 'custom'] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];
export const TOP_PRODUCTS_LIMIT = 5;
export const TREND_MONTHS = 12;
