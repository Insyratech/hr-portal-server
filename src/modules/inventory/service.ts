import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  canManageAuthorizations,
  canManageCatalog,
  canManageCategories,
  canManageLocations,
  canViewInventoryAdminOverview,
  canViewInventoryOverview,
  type RequestMeta,
} from './access';
import type {
  InventoryAdminOverview,
  InventoryAlertMode,
  InventoryAuthorization,
  InventoryCatalogItem,
  InventoryCategory,
  InventoryEmployeeOption,
  InventoryLocation,
  InventoryLocationType,
  InventoryOverview,
  InventoryStatus,
} from './types';

const MAX_QTY_CHIPS = 15;

type LocationRow = {
  id: string;
  code: string;
  name: string;
  description: string;
  location_type: InventoryLocationType;
  status: InventoryStatus;
  created_at: string;
  updated_at: string;
};

type CategoryRow = {
  id: string;
  code: string;
  name: string;
  sort_order: number;
  deduction_mode: 'measured' | 'box';
  default_alert_mode: InventoryAlertMode;
  default_reorder_qty: number | string | null;
  default_velocity_days: number;
  default_expiry_lead_days: number;
  is_system: boolean;
  created_at: string;
  updated_at: string;
};

type CatalogRow = {
  id: string;
  category_id: string;
  name: string;
  unit: string;
  default_qty_chips: unknown;
  alert_mode: InventoryAlertMode;
  reorder_qty: number | string | null;
  velocity_days: number | null;
  expiry_lead_days: number | null;
  notes: string;
  status: InventoryStatus;
  created_at: string;
  updated_at: string;
  inventory_categories?: { code: string; name: string } | { code: string; name: string }[] | null;
};

type AuthRow = {
  id: string;
  employee_id: string;
  can_usage: boolean;
  can_receipt: boolean;
  can_prep: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
  employees?:
    | {
        employee_code: string;
        full_name: string;
        email: string;
        status: string;
        deleted_at: string | null;
      }
    | {
        employee_code: string;
        full_name: string;
        email: string;
        status: string;
        deleted_at: string | null;
      }[]
    | null;
};

function asNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function mapLocation(row: LocationRow): InventoryLocation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    locationType: row.location_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCategory(row: CategoryRow): InventoryCategory {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sortOrder: row.sort_order,
    deductionMode: row.deduction_mode,
    defaultAlertMode: row.default_alert_mode,
    defaultReorderQty: asNumber(row.default_reorder_qty),
    defaultVelocityDays: row.default_velocity_days,
    defaultExpiryLeadDays: row.default_expiry_lead_days,
    isSystem: row.is_system,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseQtyChips(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeQtyChips(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Default qty chips must be a list.', 400);
  }
  if (input.length > MAX_QTY_CHIPS) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `At most ${MAX_QTY_CHIPS} default qty chips are allowed.`,
      400,
    );
  }
  const chips: number[] = [];
  const seen = new Set<number>();
  for (const item of input) {
    const num = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(num) || num <= 0) {
      throw new AppError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Each qty chip must be a positive number.',
        400,
      );
    }
    const rounded = Math.round(num * 10000) / 10000;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    chips.push(rounded);
  }
  return chips;
}

function categoryJoin(row: CatalogRow): { code: string; name: string } {
  const rel = row.inventory_categories;
  if (Array.isArray(rel)) return rel[0] ?? { code: '', name: '' };
  return rel ?? { code: '', name: '' };
}

function mapCatalog(row: CatalogRow): InventoryCatalogItem {
  const category = categoryJoin(row);
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryCode: category.code,
    categoryName: category.name,
    name: row.name,
    unit: row.unit,
    defaultQtyChips: parseQtyChips(row.default_qty_chips),
    alertMode: row.alert_mode,
    reorderQty: asNumber(row.reorder_qty),
    velocityDays: row.velocity_days,
    expiryLeadDays: row.expiry_lead_days,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
  };
}

function employeeJoin(row: AuthRow) {
  const rel = row.employees;
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}

function mapAuthorization(row: AuthRow): InventoryAuthorization {
  const employee = employeeJoin(row);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: employee?.employee_code ?? '',
    employeeName: employee?.full_name ?? '',
    employeeEmail: employee?.email ?? '',
    canUsage: row.can_usage,
    canReceipt: row.can_receipt,
    canPrep: row.can_prep,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function countTable(supabase: SupabaseClient, table: string): Promise<number> {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to count ${table}.`, 500);
  }
  return count ?? 0;
}

export function createInventoryService(supabase: SupabaseClient) {
  return {
    async getOverview(actor: RequestUser): Promise<InventoryOverview> {
      if (!canViewInventoryOverview(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view inventory overview.', 403);
      }
      const [locations, categories, catalogItems, authorizations, activeLots, plasticStock, stations] =
        await Promise.all([
          countTable(supabase, 'inventory_locations'),
          countTable(supabase, 'inventory_categories'),
          countTable(supabase, 'inventory_catalog_items'),
          countTable(supabase, 'inventory_authorizations'),
          (async () => {
            const { count, error } = await supabase
              .from('inventory_lots')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active');
            if (error) return 0;
            return count ?? 0;
          })(),
          (async () => {
            const { count, error } = await supabase
              .from('inventory_plastic_stock')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active');
            if (error) return 0;
            return count ?? 0;
          })(),
          countTable(supabase, 'inventory_stations'),
        ]);
      return {
        phase: 7,
        title: 'Inventory',
        message:
          'Receive stock, run prep, watch alerts, open Reports for spend/usage, and use Scan on a lab phone to open labels without a separate QR app.',
        modules: {
          locations: 'ready',
          categories: 'ready',
          catalog: 'ready',
          authorizations: 'ready',
          lots: 'ready',
          plasticWares: 'ready',
          reagents: 'ready',
          alerts: 'ready',
          reports: 'ready',
          scan: 'ready',
        },
        counts: {
          locations,
          categories,
          catalogItems,
          authorizations,
          activeLots,
          plasticStock,
          stations,
        },
      };
    },

    async getAdminOverview(actor: RequestUser): Promise<InventoryAdminOverview> {
      if (!canViewInventoryAdminOverview(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can open this overview.', 403);
      }
      const [locations, categories, catalogItems, authorizations, activeLots, plasticStock] =
        await Promise.all([
          countTable(supabase, 'inventory_locations'),
          countTable(supabase, 'inventory_categories'),
          countTable(supabase, 'inventory_catalog_items'),
          countTable(supabase, 'inventory_authorizations'),
          (async () => {
            const { count, error } = await supabase
              .from('inventory_lots')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active');
            if (error) return 0;
            return count ?? 0;
          })(),
          (async () => {
            const { count, error } = await supabase
              .from('inventory_plastic_stock')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active');
            if (error) return 0;
            return count ?? 0;
          })(),
        ]);
      return {
        phase: 7,
        title: 'Inventory',
        message:
          'Read-only inventory summary. Open the inventory dashboard for spend, usage, stock health, and the alert queue. Inventory Manager owns day-to-day operations.',
        counts: { locations, categories, catalogItems, authorizations, activeLots, plasticStock },
      };
    },

    async listLocations(actor: RequestUser): Promise<InventoryLocation[]> {
      if (!canManageLocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view locations.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_locations')
        .select('*')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list locations.', 500);
      }
      return ((data ?? []) as LocationRow[]).map(mapLocation);
    },

    async createLocation(
      actor: RequestUser,
      input: {
        code: string;
        name: string;
        description?: string;
        locationType?: InventoryLocationType;
      },
      meta: RequestMeta,
    ): Promise<InventoryLocation> {
      if (!canManageLocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage locations.', 403);
      }
      const code = input.code.trim().toUpperCase();
      const name = input.name.trim();
      if (!code || !name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Location code and name are required.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_locations')
        .insert({
          code,
          name,
          description: (input.description ?? '').trim(),
          location_type: input.locationType ?? 'store',
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A location with this code already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create location.', 500);
      }
      const created = mapLocation(data as LocationRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_location.create',
        entityType: 'inventory_location',
        entityId: created.id,
        newValues: { code, name, locationType: created.locationType },
        ...meta,
      });
      return created;
    },

    async updateLocation(
      actor: RequestUser,
      id: string,
      input: Partial<{
        name: string;
        description: string;
        locationType: InventoryLocationType;
        status: InventoryStatus;
      }>,
      meta: RequestMeta,
    ): Promise<InventoryLocation> {
      if (!canManageLocations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage locations.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.description !== undefined) patch.description = input.description.trim();
      if (input.locationType !== undefined) patch.location_type = input.locationType;
      if (input.status !== undefined) patch.status = input.status;
      if (Object.keys(patch).length === 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No location fields to update.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_locations')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Location not found.', 404);
      }
      const updated = mapLocation(data as LocationRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_location.update',
        entityType: 'inventory_location',
        entityId: updated.id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listCategories(actor: RequestUser): Promise<InventoryCategory[]> {
      if (!canManageCategories(actor) && !canManageCatalog(actor) && !canViewInventoryOverview(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view categories.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_categories')
        .select('*')
        .order('sort_order')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list categories.', 500);
      }
      return ((data ?? []) as CategoryRow[]).map(mapCategory);
    },

    async updateCategoryDefaults(
      actor: RequestUser,
      id: string,
      input: {
        defaultAlertMode?: InventoryAlertMode;
        defaultReorderQty?: number | null;
        defaultVelocityDays?: number;
        defaultExpiryLeadDays?: number;
      },
      meta: RequestMeta,
    ): Promise<InventoryCategory> {
      if (!canManageCategories(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage category defaults.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.defaultAlertMode !== undefined) patch.default_alert_mode = input.defaultAlertMode;
      if (input.defaultReorderQty !== undefined) {
        patch.default_reorder_qty =
          input.defaultReorderQty === null ? null : Number(input.defaultReorderQty);
      }
      if (input.defaultVelocityDays !== undefined) {
        if (input.defaultVelocityDays < 1 || input.defaultVelocityDays > 365) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Velocity days must be 1–365.', 400);
        }
        patch.default_velocity_days = input.defaultVelocityDays;
      }
      if (input.defaultExpiryLeadDays !== undefined) {
        if (input.defaultExpiryLeadDays < 0 || input.defaultExpiryLeadDays > 365) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Expiry lead days must be 0–365.', 400);
        }
        patch.default_expiry_lead_days = input.defaultExpiryLeadDays;
      }
      if (Object.keys(patch).length === 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No category defaults to update.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_categories')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Category not found.', 404);
      }
      const updated = mapCategory(data as CategoryRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_category.update_defaults',
        entityType: 'inventory_category',
        entityId: updated.id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listCatalogItems(actor: RequestUser): Promise<InventoryCatalogItem[]> {
      if (!canManageCatalog(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view catalog items.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_catalog_items')
        .select('*, inventory_categories(code, name)')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list catalog items.', 500);
      }
      return ((data ?? []) as CatalogRow[]).map(mapCatalog);
    },

    async createCatalogItem(
      actor: RequestUser,
      input: {
        categoryId: string;
        name: string;
        unit: string;
        defaultQtyChips?: number[];
        alertMode?: InventoryAlertMode;
        reorderQty?: number | null;
        velocityDays?: number | null;
        expiryLeadDays?: number | null;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<InventoryCatalogItem> {
      if (!canManageCatalog(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage catalog items.', 403);
      }
      const name = input.name.trim();
      const unit = input.unit.trim();
      if (!input.categoryId || !name || !unit) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Category, name, and unit are required.',
          400,
        );
      }
      const chips = normalizeQtyChips(input.defaultQtyChips ?? []);
      const { data: category, error: categoryError } = await supabase
        .from('inventory_categories')
        .select('*')
        .eq('id', input.categoryId)
        .single();
      if (categoryError || !category) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown inventory category.', 400);
      }
      const categoryRow = category as CategoryRow;
      const alertMode = input.alertMode ?? categoryRow.default_alert_mode;
      const { data, error } = await supabase
        .from('inventory_catalog_items')
        .insert({
          category_id: input.categoryId,
          name,
          unit,
          default_qty_chips: chips,
          alert_mode: alertMode,
          reorder_qty: input.reorderQty ?? categoryRow.default_reorder_qty,
          velocity_days: input.velocityDays ?? categoryRow.default_velocity_days,
          expiry_lead_days: input.expiryLeadDays ?? categoryRow.default_expiry_lead_days,
          notes: (input.notes ?? '').trim(),
        })
        .select('*, inventory_categories(code, name)')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'A catalog item with this name already exists in the category.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create catalog item.', 500);
      }
      const created = mapCatalog(data as CatalogRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_catalog_item.create',
        entityType: 'inventory_catalog_item',
        entityId: created.id,
        newValues: { name, unit, categoryId: input.categoryId, alertMode },
        ...meta,
      });
      return created;
    },

    async updateCatalogItem(
      actor: RequestUser,
      id: string,
      input: Partial<{
        name: string;
        unit: string;
        defaultQtyChips: number[];
        alertMode: InventoryAlertMode;
        reorderQty: number | null;
        velocityDays: number | null;
        expiryLeadDays: number | null;
        notes: string;
        status: InventoryStatus;
      }>,
      meta: RequestMeta,
    ): Promise<InventoryCatalogItem> {
      if (!canManageCatalog(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage catalog items.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.unit !== undefined) patch.unit = input.unit.trim();
      if (input.defaultQtyChips !== undefined) patch.default_qty_chips = normalizeQtyChips(input.defaultQtyChips);
      if (input.alertMode !== undefined) patch.alert_mode = input.alertMode;
      if (input.reorderQty !== undefined) patch.reorder_qty = input.reorderQty;
      if (input.velocityDays !== undefined) patch.velocity_days = input.velocityDays;
      if (input.expiryLeadDays !== undefined) patch.expiry_lead_days = input.expiryLeadDays;
      if (input.notes !== undefined) patch.notes = input.notes.trim();
      if (input.status !== undefined) patch.status = input.status;
      if (Object.keys(patch).length === 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No catalog fields to update.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_catalog_items')
        .update(patch)
        .eq('id', id)
        .select('*, inventory_categories(code, name)')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'A catalog item with this name already exists in the category.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Catalog item not found.', 404);
      }
      const updated = mapCatalog(data as CatalogRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_catalog_item.update',
        entityType: 'inventory_catalog_item',
        entityId: updated.id,
        newValues: patch,
        ...meta,
      });
      return updated;
    },

    async listEmployeeOptions(actor: RequestUser): Promise<InventoryEmployeeOption[]> {
      if (!canManageAuthorizations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot list employees for authorizations.', 403);
      }
      const { data, error } = await supabase
        .from('employees')
        .select('id, employee_code, full_name, email')
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('full_name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list employees.', 500);
      }
      return ((data ?? []) as Array<{
        id: string;
        employee_code: string;
        full_name: string;
        email: string;
      }>).map((row) => ({
        id: row.id,
        employeeCode: row.employee_code,
        fullName: row.full_name,
        email: row.email,
      }));
    },

    async listAuthorizations(actor: RequestUser): Promise<InventoryAuthorization[]> {
      if (!canManageAuthorizations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view authorizations.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_authorizations')
        .select('*, employees(employee_code, full_name, email, status, deleted_at)')
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list authorizations.', 500);
      }
      return ((data ?? []) as AuthRow[]).map(mapAuthorization);
    },

    async upsertAuthorization(
      actor: RequestUser,
      input: {
        employeeId: string;
        canUsage: boolean;
        canReceipt: boolean;
        canPrep: boolean;
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<InventoryAuthorization> {
      if (!canManageAuthorizations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage authorizations.', 403);
      }
      if (!input.employeeId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Employee is required.', 400);
      }
      if (!input.canUsage && !input.canReceipt && !input.canPrep) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Grant at least one of usage, receipt, or prep.',
          400,
        );
      }
      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, status, deleted_at')
        .eq('id', input.employeeId)
        .single();
      if (employeeError || !employee || employee.deleted_at || employee.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active employee.', 400);
      }

      const payload = {
        employee_id: input.employeeId,
        can_usage: input.canUsage,
        can_receipt: input.canReceipt,
        can_prep: input.canPrep,
        notes: (input.notes ?? '').trim(),
      };

      const { data: existing } = await supabase
        .from('inventory_authorizations')
        .select('id')
        .eq('employee_id', input.employeeId)
        .maybeSingle();

      let row: AuthRow | null = null;
      if (existing?.id) {
        const { data, error } = await supabase
          .from('inventory_authorizations')
          .update(payload)
          .eq('id', existing.id)
          .select('*, employees(employee_code, full_name, email, status, deleted_at)')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to update authorization.', 500);
        }
        row = data as AuthRow;
      } else {
        const { data, error } = await supabase
          .from('inventory_authorizations')
          .insert(payload)
          .select('*, employees(employee_code, full_name, email, status, deleted_at)')
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create authorization.', 500);
        }
        row = data as AuthRow;
      }

      const mapped = mapAuthorization(row);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: existing?.id ? 'inventory_authorization.update' : 'inventory_authorization.create',
        entityType: 'inventory_authorization',
        entityId: mapped.id,
        newValues: {
          employeeId: mapped.employeeId,
          canUsage: mapped.canUsage,
          canReceipt: mapped.canReceipt,
          canPrep: mapped.canPrep,
        },
        ...meta,
      });
      return mapped;
    },

    async deleteAuthorization(
      actor: RequestUser,
      id: string,
      meta: RequestMeta,
    ): Promise<{ id: string }> {
      if (!canManageAuthorizations(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage authorizations.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_authorizations')
        .delete()
        .eq('id', id)
        .select('id, employee_id')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Authorization not found.', 404);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_authorization.delete',
        entityType: 'inventory_authorization',
        entityId: id,
        oldValues: { employeeId: data.employee_id },
        ...meta,
      });
      return { id };
    },
  };
}
