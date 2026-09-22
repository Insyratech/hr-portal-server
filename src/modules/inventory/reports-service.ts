import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { canViewInventoryAdminOverview, canViewReports } from './access';
import { createInventoryAlertsService } from './alerts-service';
import type {
  InventoryAdjustmentRow,
  InventoryAdminDashboard,
  InventoryAuditExport,
  InventoryNamedAmount,
  InventoryReportPeriod,
  InventoryReportsBundle,
  InventoryUsageLeaderRow,
} from './types';

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const escape = (value: string | number | null | undefined): string => {
    const text = value == null ? '' : String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n');
}

function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isIsoDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function resolveInventoryReportRange(input: {
  period?: string;
  from?: string;
  to?: string;
}): InventoryReportsBundle['range'] {
  const today = utcToday();

  if (isIsoDate(input.from) && isIsoDate(input.to)) {
    if (input.from > input.to) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'From date must be on or before to date.', 400);
    }
    return {
      from: input.from,
      to: input.to,
      period: 'custom',
      label: `${input.from} → ${input.to}`,
    };
  }

  const period = (input.period ?? 'month') as InventoryReportPeriod;
  if (period === 'custom') {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Custom range requires from and to dates.', 400);
  }

  if (period === 'day') {
    const day = toIso(today);
    return { from: day, to: day, period, label: day };
  }

  if (period === 'week') {
    const day = today.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setUTCDate(today.getUTCDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      from: toIso(monday),
      to: toIso(sunday),
      period,
      label: `Week of ${toIso(monday)}`,
    };
  }

  if (period === 'month') {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    const ym = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    return { from: toIso(from), to: toIso(to), period, label: ym };
  }

  if (period === 'quarter') {
    const q = Math.floor(today.getUTCMonth() / 3);
    const from = new Date(Date.UTC(today.getUTCFullYear(), q * 3, 1));
    const to = new Date(Date.UTC(today.getUTCFullYear(), q * 3 + 3, 0));
    return {
      from: toIso(from),
      to: toIso(to),
      period,
      label: `Q${q + 1} ${today.getUTCFullYear()}`,
    };
  }

  const from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const to = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
  return {
    from: toIso(from),
    to: toIso(to),
    period: 'year',
    label: String(today.getUTCFullYear()),
  };
}

function bumpNamed(
  map: Map<string, InventoryNamedAmount>,
  id: string,
  name: string,
  amount: number,
): void {
  const existing = map.get(id);
  if (existing) {
    existing.amount = roundMoney(existing.amount + amount);
    return;
  }
  map.set(id, { id, name, amount: roundMoney(amount) });
}

function sortNamed(map: Map<string, InventoryNamedAmount>): InventoryNamedAmount[] {
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

function bumpUsage(
  map: Map<string, InventoryUsageLeaderRow>,
  id: string,
  name: string,
  qty: number,
  unit: string,
): void {
  const existing = map.get(id);
  if (existing) {
    existing.issueCount += 1;
    existing.qty = roundMoney(existing.qty + qty);
    return;
  }
  map.set(id, { id, name, issueCount: 1, qty: roundMoney(qty), unit });
}

function sortUsage(map: Map<string, InventoryUsageLeaderRow>): InventoryUsageLeaderRow[] {
  return [...map.values()].sort((a, b) => b.issueCount - a.issueCount || b.qty - a.qty);
}

type LotSpendRow = {
  id: string;
  lot_code: string;
  total_cost: number | string;
  purchase_date: string;
  counts_toward_purchase_expense: boolean | null;
  location_id: string;
  catalog_item_id: string;
  inventory_catalog_items?:
    | {
        id: string;
        name: string;
        inventory_categories?:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }
    | {
        id: string;
        name: string;
        inventory_categories?:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }[]
    | null;
  inventory_locations?:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null;
};

type PlasticReceiveRow = {
  id: string;
  boxes: number | string;
  created_at: string;
  plastic_stock_id: string;
  inventory_plastic_stock?:
    | {
        id: string;
        stock_code: string;
        total_cost: number | string;
        boxes_received: number | string;
        location_id: string;
        catalog_item_id: string;
        inventory_catalog_items?:
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }[]
          | null;
        inventory_locations?:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }
    | {
        id: string;
        stock_code: string;
        total_cost: number | string;
        boxes_received: number | string;
        location_id: string;
        catalog_item_id: string;
        inventory_catalog_items?:
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }[]
          | null;
        inventory_locations?:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }[]
    | null;
};

type LotIssueRow = {
  id: string;
  qty: number | string;
  unit: string;
  created_at: string;
  employee_id: string | null;
  lot_id: string;
  employees?:
    | { full_name: string }
    | { full_name: string }[]
    | null;
  inventory_lots?:
    | {
        lot_code: string;
        catalog_item_id: string;
        inventory_catalog_items?:
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }[]
          | null;
      }
    | {
        lot_code: string;
        catalog_item_id: string;
        inventory_catalog_items?:
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }[]
          | null;
      }[]
    | null;
};

type PlasticIssueRow = {
  id: string;
  boxes: number | string;
  unit: string;
  created_at: string;
  employee_id: string | null;
  employees?:
    | { full_name: string }
    | { full_name: string }[]
    | null;
  inventory_plastic_stock?:
    | {
        stock_code: string;
        size_label: string;
        catalog_item_id: string;
        inventory_catalog_items?:
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }[]
          | null;
      }
    | {
        stock_code: string;
        size_label: string;
        catalog_item_id: string;
        inventory_catalog_items?:
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }
          | {
              id: string;
              name: string;
              inventory_categories?:
                | { id: string; name: string }
                | { id: string; name: string }[]
                | null;
            }[]
          | null;
      }[]
    | null;
};

type LotAdjustRow = {
  id: string;
  lot_id: string;
  qty: number | string;
  unit: string;
  notes: string;
  created_at: string;
  employees?:
    | { full_name: string }
    | { full_name: string }[]
    | null;
  inventory_lots?:
    | {
        lot_code: string;
        inventory_catalog_items?: { name: string } | { name: string }[] | null;
      }
    | {
        lot_code: string;
        inventory_catalog_items?: { name: string } | { name: string }[] | null;
      }[]
    | null;
};

type PlasticAdjustRow = {
  id: string;
  plastic_stock_id: string;
  boxes: number | string;
  unit: string;
  notes: string;
  created_at: string;
  employees?:
    | { full_name: string }
    | { full_name: string }[]
    | null;
  inventory_plastic_stock?:
    | {
        stock_code: string;
        size_label: string;
        inventory_catalog_items?: { name: string } | { name: string }[] | null;
      }
    | {
        stock_code: string;
        size_label: string;
        inventory_catalog_items?: { name: string } | { name: string }[] | null;
      }[]
    | null;
};

async function countStatus(
  supabase: SupabaseClient,
  table: string,
  status: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('status', status);
  if (error) return 0;
  return count ?? 0;
}

export function createInventoryReportsService(supabase: SupabaseClient) {
  async function buildReports(range: InventoryReportsBundle['range']): Promise<InventoryReportsBundle> {
    const fromTs = `${range.from}T00:00:00.000Z`;
    const toTs = `${range.to}T23:59:59.999Z`;

    const byCategory = new Map<string, InventoryNamedAmount>();
    const byLocation = new Map<string, InventoryNamedAmount>();
    const byCatalogItem = new Map<string, InventoryNamedAmount>();
    let lotSpend = 0;
    let plasticSpend = 0;

    const { data: lotRows, error: lotError } = await supabase
      .from('inventory_lots')
      .select(
        `id, lot_code, total_cost, purchase_date, counts_toward_purchase_expense, location_id, catalog_item_id,
         inventory_catalog_items(id, name, inventory_categories(id, name)),
         inventory_locations(id, name)`,
      )
      .gte('purchase_date', range.from)
      .lte('purchase_date', range.to)
      .eq('counts_toward_purchase_expense', true);
    if (lotError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lot spend.', 500);
    }

    for (const row of (lotRows ?? []) as LotSpendRow[]) {
      const amount = asNumber(row.total_cost);
      if (amount <= 0) continue;
      lotSpend += amount;
      const catalog = one(row.inventory_catalog_items);
      const category = one(catalog?.inventory_categories ?? null);
      const location = one(row.inventory_locations);
      bumpNamed(byCategory, category?.id ?? 'unknown', category?.name ?? 'Uncategorized', amount);
      bumpNamed(byLocation, location?.id ?? row.location_id, location?.name ?? 'Unknown location', amount);
      bumpNamed(byCatalogItem, catalog?.id ?? row.catalog_item_id, catalog?.name ?? 'Unknown item', amount);
    }

    const { data: plasticReceives, error: plasticError } = await supabase
      .from('inventory_plastic_movements')
      .select(
        `id, boxes, created_at, plastic_stock_id,
         inventory_plastic_stock(
           id, stock_code, total_cost, boxes_received, location_id, catalog_item_id,
           inventory_catalog_items(id, name, inventory_categories(id, name)),
           inventory_locations(id, name)
         )`,
      )
      .eq('movement_type', 'receive')
      .gte('created_at', fromTs)
      .lte('created_at', toTs);
    if (plasticError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load plastic spend.', 500);
    }

    for (const row of (plasticReceives ?? []) as PlasticReceiveRow[]) {
      const stock = one(row.inventory_plastic_stock);
      if (!stock) continue;
      const received = asNumber(stock.boxes_received);
      const boxes = asNumber(row.boxes);
      if (received <= 0 || boxes <= 0) continue;
      const amount = roundMoney((asNumber(stock.total_cost) / received) * boxes);
      if (amount <= 0) continue;
      plasticSpend += amount;
      const catalog = one(stock.inventory_catalog_items);
      const category = one(catalog?.inventory_categories ?? null);
      const location = one(stock.inventory_locations);
      bumpNamed(byCategory, category?.id ?? 'unknown', category?.name ?? 'Uncategorized', amount);
      bumpNamed(
        byLocation,
        location?.id ?? stock.location_id,
        location?.name ?? 'Unknown location',
        amount,
      );
      bumpNamed(
        byCatalogItem,
        catalog?.id ?? stock.catalog_item_id,
        catalog?.name ?? 'Unknown item',
        amount,
      );
    }

    const byEmployee = new Map<string, InventoryUsageLeaderRow>();
    const usageByItem = new Map<string, InventoryUsageLeaderRow>();
    const usageByCategory = new Map<string, InventoryUsageLeaderRow>();
    let issueCount = 0;

    const { data: lotIssues, error: lotIssueError } = await supabase
      .from('inventory_movements')
      .select(
        `id, qty, unit, created_at, employee_id, lot_id,
         employees(full_name),
         inventory_lots(
           lot_code, catalog_item_id,
           inventory_catalog_items(id, name, inventory_categories(id, name))
         )`,
      )
      .eq('movement_type', 'issue')
      .gte('created_at', fromTs)
      .lte('created_at', toTs);
    if (lotIssueError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lot usage.', 500);
    }

    for (const row of (lotIssues ?? []) as LotIssueRow[]) {
      issueCount += 1;
      const qty = asNumber(row.qty);
      const lot = one(row.inventory_lots);
      const catalog = one(lot?.inventory_catalog_items ?? null);
      const category = one(catalog?.inventory_categories ?? null);
      const employee = one(row.employees);
      const empId = row.employee_id ?? 'unknown';
      const empName = employee?.full_name ?? 'Unknown';
      bumpUsage(byEmployee, empId, empName, qty, row.unit);
      bumpUsage(
        usageByItem,
        catalog?.id ?? lot?.catalog_item_id ?? 'unknown',
        catalog?.name ?? 'Unknown item',
        qty,
        row.unit,
      );
      bumpUsage(
        usageByCategory,
        category?.id ?? 'unknown',
        category?.name ?? 'Uncategorized',
        qty,
        row.unit,
      );
    }

    const { data: plasticIssues, error: plasticIssueError } = await supabase
      .from('inventory_plastic_movements')
      .select(
        `id, boxes, unit, created_at, employee_id,
         employees(full_name),
         inventory_plastic_stock(
           stock_code, size_label, catalog_item_id,
           inventory_catalog_items(id, name, inventory_categories(id, name))
         )`,
      )
      .eq('movement_type', 'issue')
      .gte('created_at', fromTs)
      .lte('created_at', toTs);
    if (plasticIssueError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load plastic usage.', 500);
    }

    for (const row of (plasticIssues ?? []) as PlasticIssueRow[]) {
      issueCount += 1;
      const qty = asNumber(row.boxes);
      const stock = one(row.inventory_plastic_stock);
      const catalog = one(stock?.inventory_catalog_items ?? null);
      const category = one(catalog?.inventory_categories ?? null);
      const employee = one(row.employees);
      const empId = row.employee_id ?? 'unknown';
      const empName = employee?.full_name ?? 'Unknown';
      const itemName = catalog
        ? `${catalog.name}${stock?.size_label ? ` · ${stock.size_label}` : ''}`
        : 'Unknown item';
      bumpUsage(byEmployee, empId, empName, qty, row.unit || 'box');
      bumpUsage(
        usageByItem,
        catalog?.id ?? stock?.catalog_item_id ?? 'unknown',
        itemName,
        qty,
        row.unit || 'box',
      );
      bumpUsage(
        usageByCategory,
        category?.id ?? 'unknown',
        category?.name ?? 'Uncategorized',
        qty,
        row.unit || 'box',
      );
    }

    const adjustments: InventoryAdjustmentRow[] = [];

    const { data: lotAdjusts, error: lotAdjustError } = await supabase
      .from('inventory_movements')
      .select(
        `id, lot_id, qty, unit, notes, created_at,
         employees(full_name),
         inventory_lots(lot_code, inventory_catalog_items(name))`,
      )
      .eq('movement_type', 'adjust')
      .gte('created_at', fromTs)
      .lte('created_at', toTs)
      .order('created_at', { ascending: false });
    if (lotAdjustError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lot adjustments.', 500);
    }

    for (const row of (lotAdjusts ?? []) as LotAdjustRow[]) {
      const lot = one(row.inventory_lots);
      const catalog = one(lot?.inventory_catalog_items ?? null);
      const employee = one(row.employees);
      adjustments.push({
        id: row.id,
        subjectType: 'lot',
        subjectId: row.lot_id,
        subjectCode: lot?.lot_code ?? '',
        itemName: catalog?.name ?? '',
        qty: asNumber(row.qty),
        unit: row.unit,
        notes: row.notes,
        employeeName: employee?.full_name ?? null,
        createdAt: row.created_at,
      });
    }

    const { data: plasticAdjusts, error: plasticAdjustError } = await supabase
      .from('inventory_plastic_movements')
      .select(
        `id, plastic_stock_id, boxes, unit, notes, created_at,
         employees(full_name),
         inventory_plastic_stock(stock_code, size_label, inventory_catalog_items(name))`,
      )
      .eq('movement_type', 'adjust')
      .gte('created_at', fromTs)
      .lte('created_at', toTs)
      .order('created_at', { ascending: false });
    if (plasticAdjustError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load plastic adjustments.', 500);
    }

    for (const row of (plasticAdjusts ?? []) as PlasticAdjustRow[]) {
      const stock = one(row.inventory_plastic_stock);
      const catalog = one(stock?.inventory_catalog_items ?? null);
      const employee = one(row.employees);
      adjustments.push({
        id: row.id,
        subjectType: 'plastic_stock',
        subjectId: row.plastic_stock_id,
        subjectCode: stock?.stock_code ?? '',
        itemName: catalog
          ? `${catalog.name}${stock?.size_label ? ` · ${stock.size_label}` : ''}`
          : '',
        qty: asNumber(row.boxes),
        unit: row.unit || 'box',
        notes: row.notes,
        employeeName: employee?.full_name ?? null,
        createdAt: row.created_at,
      });
    }

    adjustments.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return {
      range,
      spend: {
        total: roundMoney(lotSpend + plasticSpend),
        lotSpend: roundMoney(lotSpend),
        plasticSpend: roundMoney(plasticSpend),
        note:
          'Spend counts purchased lots (purchase date in range) and plastic receipts. Lab-made reagents are excluded; their cost is the chemicals/solvents purchased earlier.',
        byCategory: sortNamed(byCategory),
        byLocation: sortNamed(byLocation),
        byCatalogItem: sortNamed(byCatalogItem),
      },
      usage: {
        issueCount,
        byEmployee: sortUsage(byEmployee).slice(0, 50),
        byCatalogItem: sortUsage(usageByItem).slice(0, 50),
        byCategory: sortUsage(usageByCategory),
      },
      adjustments: {
        count: adjustments.length,
        rows: adjustments.slice(0, 100),
      },
    };
  }

  return {
    async getReports(
      actor: RequestUser,
      query: { period?: string; from?: string; to?: string },
    ): Promise<InventoryReportsBundle> {
      if (!canViewReports(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view inventory reports.', 403);
      }
      const range = resolveInventoryReportRange(query);
      return buildReports(range);
    },

    async getAdminDashboard(
      actor: RequestUser,
      query: { period?: string; from?: string; to?: string },
    ): Promise<InventoryAdminDashboard> {
      if (!canViewInventoryAdminOverview(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can open this dashboard.', 403);
      }
      const range = resolveInventoryReportRange(query);
      const reports = await buildReports(range);
      const alertsSvc = createInventoryAlertsService(supabase);
      const [activeAlerts, alertQueue, locations, catalogItems, stations, authorizations] =
        await Promise.all([
          alertsSvc.evaluateAlerts(),
          alertsSvc.listAlertLogInternal(14),
          supabase.from('inventory_locations').select('id', { count: 'exact', head: true }),
          supabase.from('inventory_catalog_items').select('id', { count: 'exact', head: true }),
          supabase.from('inventory_stations').select('id', { count: 'exact', head: true }),
          supabase.from('inventory_authorizations').select('id', { count: 'exact', head: true }),
        ]);

      const [
        activeLots,
        depletedLots,
        voidLots,
        activePlastic,
        depletedPlastic,
      ] = await Promise.all([
        countStatus(supabase, 'inventory_lots', 'active'),
        countStatus(supabase, 'inventory_lots', 'depleted'),
        countStatus(supabase, 'inventory_lots', 'void'),
        countStatus(supabase, 'inventory_plastic_stock', 'active'),
        countStatus(supabase, 'inventory_plastic_stock', 'depleted'),
      ]);

      return {
        phase: 7,
        title: 'Inventory dashboard',
        message:
          'Stock health, spend, usage, and alert queue. Inventory Manager operates day-to-day; this view is oversight.',
        range,
        kpis: {
          locations: locations.count ?? 0,
          catalogItems: catalogItems.count ?? 0,
          activeLots,
          plasticStock: activePlastic,
          depletedLots,
          stations: stations.count ?? 0,
          authorizations: authorizations.count ?? 0,
          activeAlerts: activeAlerts.length,
          spendInRange: reports.spend.total,
          issuesInRange: reports.usage.issueCount,
          adjustmentsInRange: reports.adjustments.count,
        },
        stockHealth: {
          activeLots,
          depletedLots,
          voidLots,
          activePlastic,
          depletedPlastic,
        },
        spend: reports.spend,
        usage: reports.usage,
        adjustments: reports.adjustments,
        alertQueue: alertQueue.slice(0, 30),
        activeAlerts: activeAlerts.slice(0, 40),
      };
    },

    async exportAuditCsv(
      actor: RequestUser,
      query: { from?: string; to?: string },
    ): Promise<InventoryAuditExport> {
      if (!canViewReports(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot export inventory audit.', 403);
      }
      if (!isIsoDate(query.from) || !isIsoDate(query.to)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'from and to dates are required.', 400);
      }
      if (query.from > query.to) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'From date must be on or before to date.', 400);
      }

      const fromTs = `${query.from}T00:00:00.000Z`;
      const toTs = `${query.to}T23:59:59.999Z`;

      const { data: auditRows, error: auditError } = await supabase
        .from('audit_logs')
        .select(
          'id, actor_id, action, entity_type, entity_id, new_values, ip_address, created_at',
        )
        .like('action', 'inventory%')
        .gte('created_at', fromTs)
        .lte('created_at', toTs)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (auditError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load inventory audit logs.', 500);
      }

      const headers = [
        'createdAt',
        'source',
        'action',
        'entityType',
        'entityId',
        'actorId',
        'detail',
        'ipAddress',
      ];
      const rows: Array<Array<string | number | null>> = ((auditRows ?? []) as Array<{
        id: string;
        actor_id: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        new_values: Record<string, unknown> | null;
        ip_address: string | null;
        created_at: string;
      }>).map((row) => [
        row.created_at,
        'audit_log',
        row.action,
        row.entity_type,
        row.entity_id,
        row.actor_id,
        row.new_values ? JSON.stringify(row.new_values) : '',
        row.ip_address,
      ]);

      const csv = toCsv(headers, rows);
      const filename = `inventory-audit-${query.from}-to-${query.to}.csv`;
      return {
        filename,
        contentType: 'text/csv; charset=utf-8',
        csv,
        rowCount: rows.length,
        range: { from: query.from, to: query.to },
      };
    },
  };
}
