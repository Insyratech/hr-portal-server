import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { portalUrl, sendPortalMail } from '../notifications/mail';
import { listStaffByRole } from '../notifications/notify-staff';
import { notifyUser } from '../notifications/notify-user';
import { canViewAlerts } from './access';
import type {
  InventoryAlert,
  InventoryAlertKind,
  InventoryAlertLogEntry,
  InventoryAlertMode,
  InventoryAlertRunResult,
  InventoryAlertSubjectType,
} from './types';

type CatalogPolicy = {
  id: string;
  name: string;
  unit: string;
  alertMode: InventoryAlertMode;
  reorderQty: number | null;
  velocityDays: number | null;
  expiryLeadDays: number | null;
  categoryName: string;
};

type LotEvalRow = {
  id: string;
  lot_code: string;
  remaining_qty: number | string;
  expiry_date: string | null;
  status: string;
  unit: string;
  catalog_item_id: string;
  location_id: string;
  inventory_catalog_items?:
    | {
        id: string;
        name: string;
        unit: string;
        alert_mode: InventoryAlertMode;
        reorder_qty: number | string | null;
        velocity_days: number | null;
        expiry_lead_days: number | null;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }
    | {
        id: string;
        name: string;
        unit: string;
        alert_mode: InventoryAlertMode;
        reorder_qty: number | string | null;
        velocity_days: number | null;
        expiry_lead_days: number | null;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }[]
    | null;
  inventory_locations?: { name: string } | { name: string }[] | null;
};

type PlasticEvalRow = {
  id: string;
  stock_code: string;
  boxes_on_hand: number | string;
  status: string;
  unit: string;
  size_label: string;
  catalog_item_id: string;
  location_id: string;
  inventory_catalog_items?:
    | {
        id: string;
        name: string;
        unit: string;
        alert_mode: InventoryAlertMode;
        reorder_qty: number | string | null;
        velocity_days: number | null;
        expiry_lead_days: number | null;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }
    | {
        id: string;
        name: string;
        unit: string;
        alert_mode: InventoryAlertMode;
        reorder_qty: number | string | null;
        velocity_days: number | null;
        expiry_lead_days: number | null;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }[]
    | null;
  inventory_locations?: { name: string } | { name: string }[] | null;
};

type LogRow = {
  id: string;
  alert_date: string;
  subject_type: InventoryAlertSubjectType;
  subject_id: string;
  alert_kind: InventoryAlertKind;
  catalog_item_id: string | null;
  title: string;
  detail: string;
  deep_link: string;
  metric_value: number | string | null;
  created_at: string;
};

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function asNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Calendar days from today to expiry (negative = already expired). */
function daysUntilExpiry(expiryIso: string, today: string): number {
  const exp = Date.parse(`${expiryIso}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  return Math.round((exp - now) / (24 * 60 * 60 * 1000));
}

function catalogPolicyFrom(
  catalog:
    | {
        id: string;
        name: string;
        unit: string;
        alert_mode: InventoryAlertMode;
        reorder_qty: number | string | null;
        velocity_days: number | null;
        expiry_lead_days: number | null;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }
    | null,
): CatalogPolicy | null {
  if (!catalog) return null;
  const category = one(catalog.inventory_categories ?? null);
  return {
    id: catalog.id,
    name: catalog.name,
    unit: catalog.unit,
    alertMode: catalog.alert_mode,
    reorderQty: asNullableNumber(catalog.reorder_qty),
    velocityDays: catalog.velocity_days,
    expiryLeadDays: catalog.expiry_lead_days,
    categoryName: category?.name ?? '',
  };
}

function wantsReorder(mode: InventoryAlertMode): boolean {
  return mode === 'reorder' || mode === 'both';
}

function wantsVelocity(mode: InventoryAlertMode): boolean {
  return mode === 'velocity' || mode === 'both';
}

function projectedDaysRemaining(
  onHand: number,
  issuedInWindow: number,
  windowDays: number,
): number | null {
  if (onHand <= 0 || windowDays <= 0) return null;
  const avgDaily = issuedInWindow / windowDays;
  if (avgDaily <= 0) return null;
  return onHand / avgDaily;
}

async function sumLotIssues(
  supabase: SupabaseClient,
  lotId: string,
  sinceIso: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('qty')
    .eq('lot_id', lotId)
    .eq('movement_type', 'issue')
    .gte('created_at', `${sinceIso}T00:00:00.000Z`);
  if (error) return 0;
  return (data ?? []).reduce((sum, row) => sum + asNumber(row.qty), 0);
}

async function sumPlasticIssues(
  supabase: SupabaseClient,
  stockId: string,
  sinceIso: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('inventory_plastic_movements')
    .select('boxes')
    .eq('plastic_stock_id', stockId)
    .eq('movement_type', 'issue')
    .gte('created_at', `${sinceIso}T00:00:00.000Z`);
  if (error) return 0;
  return (data ?? []).reduce((sum, row) => sum + asNumber(row.boxes), 0);
}

export function createInventoryAlertsService(supabase: SupabaseClient) {
  async function evaluateLotAlerts(today: string): Promise<InventoryAlert[]> {
    const { data, error } = await supabase
      .from('inventory_lots')
      .select(
        `id, lot_code, remaining_qty, expiry_date, status, unit, catalog_item_id, location_id,
         inventory_catalog_items(id, name, unit, alert_mode, reorder_qty, velocity_days, expiry_lead_days, inventory_categories(name)),
         inventory_locations(name)`,
      )
      .eq('status', 'active')
      .gt('remaining_qty', 0);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lots for alerts.', 500);
    }

    const alerts: InventoryAlert[] = [];
    for (const row of (data ?? []) as LotEvalRow[]) {
      const catalog = one(row.inventory_catalog_items);
      const policy = catalogPolicyFrom(catalog ?? null);
      if (!policy) continue;
      const location = one(row.inventory_locations);
      const remaining = asNumber(row.remaining_qty);
      const unit = row.unit || policy.unit;
      const deepLink = `/inventory/lots/${row.id}`;
      const base = {
        subjectType: 'lot' as const,
        subjectId: row.id,
        catalogItemId: policy.id,
        catalogItemName: policy.name,
        categoryName: policy.categoryName,
        locationName: location?.name ?? '',
        unit,
        subjectCode: row.lot_code,
        deepLink,
      };

      const lead = policy.expiryLeadDays;
      if (row.expiry_date && lead != null && lead >= 0) {
        const until = daysUntilExpiry(row.expiry_date, today);
        if (until <= lead) {
          alerts.push({
            ...base,
            alertKind: 'expiry',
            title: until < 0 ? `Expired: ${policy.name}` : `Near expiry: ${policy.name}`,
            detail:
              until < 0
                ? `${row.lot_code} expired ${Math.abs(until)} day(s) ago · ${remaining} ${unit} left · ${base.locationName}`
                : `${row.lot_code} expires in ${until} day(s) (lead ${lead}) · ${remaining} ${unit} left · ${base.locationName}`,
            metricValue: until,
          });
        }
      }

      if (wantsReorder(policy.alertMode) && policy.reorderQty != null && remaining <= policy.reorderQty) {
        alerts.push({
          ...base,
          alertKind: 'reorder',
          title: `Low stock: ${policy.name}`,
          detail: `${row.lot_code} has ${remaining} ${unit} (reorder at ${policy.reorderQty}) · ${base.locationName}`,
          metricValue: remaining,
        });
      }

      if (wantsVelocity(policy.alertMode) && policy.velocityDays != null && policy.velocityDays > 0) {
        const lookback = Math.max(7, policy.velocityDays);
        const since = addDaysIso(today, -lookback);
        const issued = await sumLotIssues(supabase, row.id, since);
        const projected = projectedDaysRemaining(remaining, issued, lookback);
        if (projected != null && projected <= policy.velocityDays) {
          alerts.push({
            ...base,
            alertKind: 'velocity',
            title: `Velocity warning: ${policy.name}`,
            detail: `${row.lot_code} ≈ ${projected.toFixed(1)} days left at recent use (threshold ${policy.velocityDays}) · ${remaining} ${unit} · ${base.locationName}`,
            metricValue: Math.round(projected * 100) / 100,
          });
        }
      }
    }
    return alerts;
  }

  async function evaluatePlasticAlerts(today: string): Promise<InventoryAlert[]> {
    const { data, error } = await supabase
      .from('inventory_plastic_stock')
      .select(
        `id, stock_code, boxes_on_hand, status, unit, size_label, catalog_item_id, location_id,
         inventory_catalog_items(id, name, unit, alert_mode, reorder_qty, velocity_days, expiry_lead_days, inventory_categories(name)),
         inventory_locations(name)`,
      )
      .eq('status', 'active')
      .gt('boxes_on_hand', 0);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load plastic stock for alerts.', 500);
    }

    const alerts: InventoryAlert[] = [];
    for (const row of (data ?? []) as PlasticEvalRow[]) {
      const catalog = one(row.inventory_catalog_items);
      const policy = catalogPolicyFrom(catalog ?? null);
      if (!policy) continue;
      const location = one(row.inventory_locations);
      const onHand = asNumber(row.boxes_on_hand);
      const unit = row.unit || 'box';
      const label = `${policy.name} · ${row.size_label}`;
      const deepLink = `/inventory/plastic/${row.id}`;
      const base = {
        subjectType: 'plastic_stock' as const,
        subjectId: row.id,
        catalogItemId: policy.id,
        catalogItemName: policy.name,
        categoryName: policy.categoryName,
        locationName: location?.name ?? '',
        unit,
        subjectCode: row.stock_code,
        deepLink,
      };

      if (wantsReorder(policy.alertMode) && policy.reorderQty != null && onHand <= policy.reorderQty) {
        alerts.push({
          ...base,
          alertKind: 'reorder',
          title: `Low plastic stock: ${label}`,
          detail: `${row.stock_code} has ${onHand} ${unit} (reorder at ${policy.reorderQty}) · ${base.locationName}`,
          metricValue: onHand,
        });
      }

      if (wantsVelocity(policy.alertMode) && policy.velocityDays != null && policy.velocityDays > 0) {
        const lookback = Math.max(7, policy.velocityDays);
        const since = addDaysIso(today, -lookback);
        const issued = await sumPlasticIssues(supabase, row.id, since);
        const projected = projectedDaysRemaining(onHand, issued, lookback);
        if (projected != null && projected <= policy.velocityDays) {
          alerts.push({
            ...base,
            alertKind: 'velocity',
            title: `Plastic velocity: ${label}`,
            detail: `${row.stock_code} ≈ ${projected.toFixed(1)} days left (threshold ${policy.velocityDays}) · ${onHand} ${unit} · ${base.locationName}`,
            metricValue: Math.round(projected * 100) / 100,
          });
        }
      }
    }
    return alerts;
  }

  async function claimAlert(
    today: string,
    alert: InventoryAlert,
  ): Promise<'claimed' | 'duplicate' | 'error'> {
    const { error } = await supabase.from('inventory_alert_log').insert({
      alert_date: today,
      subject_type: alert.subjectType,
      subject_id: alert.subjectId,
      alert_kind: alert.alertKind,
      catalog_item_id: alert.catalogItemId || null,
      title: alert.title,
      detail: alert.detail,
      deep_link: alert.deepLink,
      metric_value: alert.metricValue,
    });
    if (!error) return 'claimed';
    if (error.code === '23505') return 'duplicate';
    console.error('Inventory alert claim failed', error);
    return 'error';
  }

  async function evaluateAlerts(today = todayIso()): Promise<InventoryAlert[]> {
    const [lots, plastic] = await Promise.all([
      evaluateLotAlerts(today),
      evaluatePlasticAlerts(today),
    ]);
    return [...lots, ...plastic];
  }

  async function listAlertLogInternal(days = 14): Promise<InventoryAlertLogEntry[]> {
    const window = Math.min(Math.max(days, 1), 90);
    const since = addDaysIso(todayIso(), -window);
    const { data, error } = await supabase
      .from('inventory_alert_log')
      .select('*')
      .gte('alert_date', since)
      .order('alert_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load alert history.', 500);
    }

    const subjectIds = {
      lot: new Set<string>(),
      plastic_stock: new Set<string>(),
    };
    for (const row of (data ?? []) as LogRow[]) {
      subjectIds[row.subject_type].add(row.subject_id);
    }

    const lotCodes = new Map<string, string>();
    const plasticCodes = new Map<string, string>();
    if (subjectIds.lot.size) {
      const { data: lots } = await supabase
        .from('inventory_lots')
        .select('id, lot_code')
        .in('id', [...subjectIds.lot]);
      for (const lot of lots ?? []) {
        lotCodes.set(String(lot.id), String(lot.lot_code));
      }
    }
    if (subjectIds.plastic_stock.size) {
      const { data: stocks } = await supabase
        .from('inventory_plastic_stock')
        .select('id, stock_code')
        .in('id', [...subjectIds.plastic_stock]);
      for (const stock of stocks ?? []) {
        plasticCodes.set(String(stock.id), String(stock.stock_code));
      }
    }

    return ((data ?? []) as LogRow[]).map((row) => ({
      id: row.id,
      alertDate: row.alert_date,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      alertKind: row.alert_kind,
      catalogItemId: row.catalog_item_id ?? '',
      catalogItemName: '',
      categoryName: '',
      locationName: '',
      title: row.title,
      detail: row.detail,
      deepLink: row.deep_link,
      metricValue: asNullableNumber(row.metric_value),
      unit: '',
      subjectCode:
        row.subject_type === 'lot'
          ? (lotCodes.get(row.subject_id) ?? '')
          : (plasticCodes.get(row.subject_id) ?? ''),
      createdAt: row.created_at,
    }));
  }

  return {
    evaluateAlerts,

    async listActiveAlerts(actor: RequestUser): Promise<InventoryAlert[]> {
      if (!canViewAlerts(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view inventory alerts.', 403);
      }
      return evaluateAlerts();
    },

    async listAlertLog(actor: RequestUser, days = 14): Promise<InventoryAlertLogEntry[]> {
      if (!canViewAlerts(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view inventory alerts.', 403);
      }
      return listAlertLogInternal(days);
    },

    listAlertLogInternal,

    async runDailyAlerts(today = todayIso()): Promise<InventoryAlertRunResult> {
      const evaluated = await evaluateAlerts(today);
      const claimed: InventoryAlert[] = [];
      let skippedDuplicate = 0;

      for (const alert of evaluated) {
        const result = await claimAlert(today, alert);
        if (result === 'claimed') claimed.push(alert);
        else if (result === 'duplicate') skippedDuplicate += 1;
      }

      const managers = await listStaffByRole(supabase, ROLE_CODES.INVENTORY_MANAGER);
      let managersNotified = 0;
      let mailed = 0;

      if (claimed.length > 0 && managers.length > 0) {
        for (const alert of claimed) {
          for (const manager of managers) {
            try {
              await notifyUser(supabase, {
                userId: manager.userId,
                type: `inventory_alert_${alert.alertKind}`,
                title: alert.title,
                message: alert.detail,
                referenceType:
                  alert.subjectType === 'lot' ? 'inventory_lot' : 'inventory_plastic_stock',
                referenceId: alert.subjectId,
              });
              managersNotified += 1;
            } catch (error) {
              console.error('Inventory alert in-app notify failed', manager.id, error);
            }
          }
        }

        const summaryLines = claimed.map(
          (alert) => `• ${alert.title} — ${alert.detail}`,
        );
        const digestHref = portalUrl('/inventory/alerts');
        for (const manager of managers) {
          if (!manager.email.includes('@')) continue;
          try {
            const mail = await sendPortalMail({
              to: [manager.email],
              subject: `Inventory alerts (${claimed.length}) — ${today}`,
              eyebrow: 'Inventory',
              title: 'Stock & expiry alerts',
              greeting: `Hi ${manager.fullName},`,
              paragraphs: [
                `${claimed.length} new inventory alert(s) for ${today}. Each subject is emailed at most once per day.`,
                ...summaryLines.slice(0, 40),
                ...(summaryLines.length > 40
                  ? [`…and ${summaryLines.length - 40} more. Open the portal for the full list.`]
                  : []),
              ],
              cta: { label: 'Open inventory alerts', href: digestHref },
            });
            if (mail.sent) mailed += 1;
          } catch (error) {
            console.error('Inventory alert digest mail failed', manager.id, error);
          }
        }
      }

      return {
        alertDate: today,
        evaluated: evaluated.length,
        newlyClaimed: claimed.length,
        skippedDuplicate,
        managersNotified,
        mailed,
        alerts: claimed,
      };
    },
  };
}
