import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canAdjustPlastic, canManagePlastic, type RequestMeta } from './access';
import type {
  InventoryEmployeeOption,
  InventoryPlasticMovement,
  InventoryPlasticStock,
  InventoryPlasticStockStatus,
  InventoryPublicPlasticIssueResult,
  InventoryPublicStationCard,
  InventoryPublicStationItem,
  InventoryStation,
  InventoryStationPrint,
  InventoryStationStatus,
  InventorySupplierType,
} from './types';

const MAX_QTY_CHIPS = 15;
const DEFAULT_BOX_CHIPS = [1, 2, 5];

type StationRow = {
  id: string;
  location_id: string;
  name: string;
  qr_token: string;
  status: InventoryStationStatus;
  notes: string;
  created_at: string;
  updated_at: string;
  inventory_locations?:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
};

type PlasticStockRow = {
  id: string;
  stock_code: string;
  catalog_item_id: string;
  location_id: string;
  manufacturer: string;
  size_label: string;
  attributes: unknown;
  boxes_on_hand: number | string;
  boxes_received: number | string;
  unit: string;
  total_cost: number | string;
  supplier_name: string;
  supplier_type: InventorySupplierType;
  purchase_date: string;
  qty_chips: unknown;
  status: InventoryPlasticStockStatus;
  notes: string;
  received_by: string | null;
  created_at: string;
  updated_at: string;
  inventory_catalog_items?:
    | {
        id: string;
        name: string;
        category_id: string;
        inventory_categories?:
          | { id: string; code: string; name: string }
          | { id: string; code: string; name: string }[]
          | null;
      }
    | {
        id: string;
        name: string;
        category_id: string;
        inventory_categories?:
          | { id: string; code: string; name: string }
          | { id: string; code: string; name: string }[]
          | null;
      }[]
    | null;
  inventory_locations?:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
};

type PlasticMovementRow = {
  id: string;
  plastic_stock_id: string;
  station_id: string | null;
  movement_type: 'receive' | 'issue' | 'adjust';
  boxes: number | string;
  boxes_before: number | string;
  boxes_after: number | string;
  unit: string;
  employee_id: string | null;
  notes: string;
  created_by: string | null;
  created_at: string;
  employees?:
    | { employee_code: string; full_name: string }
    | { employee_code: string; full_name: string }[]
    | null;
};

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function asInt(value: number | string | null | undefined): number {
  return Math.trunc(asNumber(value));
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function parseQtyChips(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.trunc(item))
    .filter((item) => item > 0);
}

function normalizeQtyChips(input: unknown): number[] {
  if (input === undefined || input === null) return [...DEFAULT_BOX_CHIPS];
  if (!Array.isArray(input)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Qty chips must be a list.', 400);
  }
  if (input.length > MAX_QTY_CHIPS) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `At most ${MAX_QTY_CHIPS} qty chips are allowed.`,
      400,
    );
  }
  const chips: number[] = [];
  const seen = new Set<number>();
  for (const item of input) {
    const num = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each qty chip must be a positive whole number.', 400);
    }
    if (seen.has(num)) continue;
    seen.add(num);
    chips.push(num);
  }
  return chips.length ? chips : [...DEFAULT_BOX_CHIPS];
}

function parseAttributes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim();
    if (!k) continue;
    out[k] = String(value ?? '').trim();
  }
  return out;
}

function normalizeAttributes(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Attributes must be an object.', 400);
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 20) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'At most 20 attributes are allowed.', 400);
  }
  return parseAttributes(input);
}

function newQrToken(): string {
  return randomBytes(24).toString('base64url');
}

function newStockCode(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `PLS-${y}${m}${d}-${suffix}`;
}

function parseIssueRpcError(message: string | undefined): AppError {
  const text = message ?? '';
  if (text.includes('OVER_ISSUE')) {
    const match = text.match(/OVER_ISSUE:([0-9]+)/);
    const remaining = match?.[1] ?? '?';
    return new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `Box count exceeds stock on hand (${remaining}).`,
      400,
    );
  }
  if (text.includes('PLASTIC_STOCK_NOT_FOUND')) {
    return new AppError(API_ERROR_CODES.NOT_FOUND, 'Plastic stock not found.', 404);
  }
  if (text.includes('PLASTIC_STOCK_VOID')) {
    return new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This plastic stock is void.', 400);
  }
  if (text.includes('ISSUE_BOXES_INVALID')) {
    return new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Box count must be a positive whole number.', 400);
  }
  return new AppError(API_ERROR_CODES.INTERNAL_ERROR, message ?? 'Unable to issue plastic boxes.', 500);
}

function mapStation(row: StationRow): InventoryStation {
  const location = one(row.inventory_locations);
  return {
    id: row.id,
    locationId: row.location_id,
    locationCode: location?.code ?? '',
    locationName: location?.name ?? '',
    name: row.name,
    qrToken: row.qr_token,
    status: row.status,
    notes: row.notes,
    scanPath: `/scan/${row.qr_token}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlasticStock(row: PlasticStockRow): InventoryPlasticStock {
  const catalog = one(row.inventory_catalog_items);
  const category = one(catalog?.inventory_categories ?? null);
  const location = one(row.inventory_locations);
  return {
    id: row.id,
    stockCode: row.stock_code,
    catalogItemId: row.catalog_item_id,
    catalogItemName: catalog?.name ?? '',
    categoryId: category?.id ?? catalog?.category_id ?? '',
    categoryCode: category?.code ?? '',
    categoryName: category?.name ?? '',
    locationId: row.location_id,
    locationCode: location?.code ?? '',
    locationName: location?.name ?? '',
    manufacturer: row.manufacturer,
    sizeLabel: row.size_label,
    attributes: parseAttributes(row.attributes),
    boxesOnHand: asInt(row.boxes_on_hand),
    boxesReceived: asInt(row.boxes_received),
    unit: row.unit,
    totalCost: asNumber(row.total_cost),
    supplierName: row.supplier_name,
    supplierType: row.supplier_type,
    purchaseDate: row.purchase_date,
    qtyChips: parseQtyChips(row.qty_chips),
    status: row.status,
    notes: row.notes,
    receivedBy: row.received_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlasticMovement(row: PlasticMovementRow): InventoryPlasticMovement {
  const employee = one(row.employees);
  return {
    id: row.id,
    plasticStockId: row.plastic_stock_id,
    stationId: row.station_id,
    movementType: row.movement_type,
    boxes: asInt(row.boxes),
    boxesBefore: asInt(row.boxes_before),
    boxesAfter: asInt(row.boxes_after),
    unit: row.unit,
    employeeId: row.employee_id,
    employeeCode: employee?.employee_code ?? null,
    employeeName: employee?.full_name ?? null,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const STATION_SELECT = '*, inventory_locations(code, name)';
const PLASTIC_SELECT =
  '*, inventory_catalog_items(id, name, category_id, inventory_categories(id, code, name)), inventory_locations(code, name)';

async function loadActiveEmployees(supabase: SupabaseClient): Promise<InventoryEmployeeOption[]> {
  const { data: employees, error } = await supabase
    .from('employees')
    .select('id, employee_code, full_name, email')
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('full_name');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee list.', 500);
  }
  return ((employees ?? []) as Array<{
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
}

export function createInventoryPlasticService(supabase: SupabaseClient) {
  return {
    async listStations(actor: RequestUser): Promise<InventoryStation[]> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view stations.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_stations')
        .select(STATION_SELECT)
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list stations.', 500);
      }
      return ((data ?? []) as StationRow[]).map(mapStation);
    },

    async createStation(
      actor: RequestUser,
      input: { locationId: string; name: string; notes?: string },
      meta: RequestMeta,
    ): Promise<InventoryStation> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot create stations.', 403);
      }
      const name = input.name.trim();
      if (!name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Station name is required.', 400);
      }

      const { data: location, error: locationError } = await supabase
        .from('inventory_locations')
        .select('id, status, name')
        .eq('id', input.locationId)
        .single();
      if (locationError || !location || location.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active location.', 400);
      }

      const { data: inserted, error: insertError } = await supabase
        .from('inventory_stations')
        .insert({
          location_id: input.locationId,
          name,
          qr_token: newQrToken(),
          notes: (input.notes ?? '').trim(),
          status: 'active',
        })
        .select(STATION_SELECT)
        .single();
      if (insertError || !inserted) {
        if (insertError?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'This location already has a station QR. Open it from Stations.',
            409,
          );
        }
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          insertError?.message ?? 'Failed to create station.',
          500,
        );
      }

      const station = mapStation(inserted as StationRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_station.create',
        entityType: 'inventory_station',
        entityId: station.id,
        newValues: { name: station.name, locationId: station.locationId },
        ...meta,
      });
      return station;
    },

    async getStation(actor: RequestUser, id: string): Promise<InventoryStation> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view stations.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_stations')
        .select(STATION_SELECT)
        .eq('id', id)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Station not found.', 404);
      }
      return mapStation(data as StationRow);
    },

    async getStationPrint(
      actor: RequestUser,
      id: string,
      siteUrl: string,
    ): Promise<InventoryStationPrint> {
      const station = await this.getStation(actor, id);
      const base = siteUrl.replace(/\/$/, '');
      return {
        station,
        scanUrl: `${base}${station.scanPath}`,
        labelTitle: `${station.name} · ${station.locationName}`,
      };
    },

    async updateStation(
      actor: RequestUser,
      id: string,
      input: { name?: string; notes?: string; status?: InventoryStationStatus },
      meta: RequestMeta,
    ): Promise<InventoryStation> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot update stations.', 403);
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Station name is required.', 400);
        }
        patch.name = name;
      }
      if (input.notes !== undefined) patch.notes = input.notes.trim();
      if (input.status !== undefined) patch.status = input.status;
      if (!Object.keys(patch).length) {
        return this.getStation(actor, id);
      }

      const { data, error } = await supabase
        .from('inventory_stations')
        .update(patch)
        .eq('id', id)
        .select(STATION_SELECT)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Station not found.', 404);
      }
      const station = mapStation(data as StationRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_station.update',
        entityType: 'inventory_station',
        entityId: id,
        newValues: patch,
        ...meta,
      });
      return station;
    },

    async listPlasticStock(actor: RequestUser): Promise<InventoryPlasticStock[]> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view plastic stock.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_plastic_stock')
        .select(PLASTIC_SELECT)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list plastic stock.', 500);
      }
      return ((data ?? []) as PlasticStockRow[]).map(mapPlasticStock);
    },

    async getPlasticStock(actor: RequestUser, id: string): Promise<InventoryPlasticStock> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view plastic stock.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_plastic_stock')
        .select(PLASTIC_SELECT)
        .eq('id', id)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Plastic stock not found.', 404);
      }
      return mapPlasticStock(data as PlasticStockRow);
    },

    async receivePlasticStock(
      actor: RequestUser,
      input: {
        catalogItemId: string;
        locationId: string;
        manufacturer?: string;
        sizeLabel?: string;
        attributes?: Record<string, string>;
        boxes: number;
        totalCost?: number;
        supplierName?: string;
        supplierType?: InventorySupplierType;
        purchaseDate: string;
        qtyChips?: number[];
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<InventoryPlasticStock> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot receive plastic stock.', 403);
      }

      const boxes = Math.trunc(Number(input.boxes));
      if (!Number.isFinite(boxes) || boxes <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Boxes received must be a positive whole number.', 400);
      }
      if (!input.purchaseDate) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Purchase date is required.', 400);
      }

      const { data: catalog, error: catalogError } = await supabase
        .from('inventory_catalog_items')
        .select('id, name, unit, default_qty_chips, status, inventory_categories(id, code, name, deduction_mode)')
        .eq('id', input.catalogItemId)
        .single();
      if (catalogError || !catalog) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown catalog item.', 400);
      }
      if (catalog.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Catalog item is inactive.', 400);
      }
      const category = one(
        catalog.inventory_categories as
          | { id: string; code: string; name: string; deduction_mode: string }
          | { id: string; code: string; name: string; deduction_mode: string }[]
          | null,
      );
      if (!category || category.code !== 'PLASTIC_WARES' || category.deduction_mode !== 'box') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only Plastic wares catalog items can use this receipt form.',
          400,
        );
      }

      const { data: location, error: locationError } = await supabase
        .from('inventory_locations')
        .select('id, status')
        .eq('id', input.locationId)
        .single();
      if (locationError || !location || location.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active location.', 400);
      }

      const manufacturer = (input.manufacturer ?? '').trim();
      const sizeLabel = (input.sizeLabel ?? '').trim();
      if (!sizeLabel) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Size / attribute label is required (e.g. L).', 400);
      }
      const attributes = normalizeAttributes(input.attributes);
      const chips =
        input.qtyChips !== undefined
          ? normalizeQtyChips(input.qtyChips)
          : parseQtyChips(catalog.default_qty_chips).length
            ? parseQtyChips(catalog.default_qty_chips).map((n) => Math.trunc(n)).filter((n) => n > 0)
            : [...DEFAULT_BOX_CHIPS];
      const totalCost = Number(input.totalCost ?? 0);
      if (!Number.isFinite(totalCost) || totalCost < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Total cost must be zero or positive.', 400);
      }

      // Add to an existing active matching SKU line when present (same item/location/mfr/size).
      const { data: existing } = await supabase
        .from('inventory_plastic_stock')
        .select(PLASTIC_SELECT)
        .eq('catalog_item_id', input.catalogItemId)
        .eq('location_id', input.locationId)
        .eq('manufacturer', manufacturer)
        .eq('size_label', sizeLabel)
        .eq('status', 'active')
        .maybeSingle();

      if (existing) {
        const current = mapPlasticStock(existing as PlasticStockRow);
        const newReceived = current.boxesReceived + boxes;
        const newOnHand = current.boxesOnHand + boxes;
        const newCost = Math.round((current.totalCost + totalCost) * 10000) / 10000;
        const { data: updated, error: updateError } = await supabase
          .from('inventory_plastic_stock')
          .update({
            boxes_received: newReceived,
            boxes_on_hand: newOnHand,
            total_cost: newCost,
            status: 'active',
            qty_chips: chips,
            notes: (input.notes ?? '').trim() || current.notes,
          })
          .eq('id', current.id)
          .eq('boxes_on_hand', current.boxesOnHand)
          .select(PLASTIC_SELECT)
          .single();
        if (updateError || !updated) {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'Stock changed — refresh and try again.', 409);
        }

        await supabase.from('inventory_plastic_movements').insert({
          plastic_stock_id: current.id,
          movement_type: 'receive',
          boxes,
          boxes_before: current.boxesOnHand,
          boxes_after: newOnHand,
          unit: current.unit,
          employee_id: actor.employeeId,
          notes: 'Receipt (added to existing stock)',
          created_by: actor.employeeId,
        });

        const stock = mapPlasticStock(updated as PlasticStockRow);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'inventory_plastic.receive_add',
          entityType: 'inventory_plastic_stock',
          entityId: stock.id,
          newValues: { boxes, boxesOnHand: stock.boxesOnHand },
          ...meta,
        });
        return stock;
      }

      const stockCode = newStockCode();
      const { data: inserted, error: insertError } = await supabase
        .from('inventory_plastic_stock')
        .insert({
          stock_code: stockCode,
          catalog_item_id: input.catalogItemId,
          location_id: input.locationId,
          manufacturer,
          size_label: sizeLabel,
          attributes,
          boxes_on_hand: boxes,
          boxes_received: boxes,
          unit: 'box',
          total_cost: totalCost,
          supplier_name: (input.supplierName ?? '').trim(),
          supplier_type: input.supplierType ?? 'external',
          purchase_date: input.purchaseDate,
          qty_chips: chips,
          notes: (input.notes ?? '').trim(),
          received_by: actor.employeeId,
          status: 'active',
        })
        .select(PLASTIC_SELECT)
        .single();
      if (insertError || !inserted) {
        if (insertError?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'Stock code collision — please retry.', 409);
        }
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          insertError?.message ?? 'Failed to receive plastic stock.',
          500,
        );
      }

      const stock = mapPlasticStock(inserted as PlasticStockRow);
      const { error: movementError } = await supabase.from('inventory_plastic_movements').insert({
        plastic_stock_id: stock.id,
        movement_type: 'receive',
        boxes,
        boxes_before: 0,
        boxes_after: boxes,
        unit: stock.unit,
        employee_id: actor.employeeId,
        notes: 'Receipt',
        created_by: actor.employeeId,
      });
      if (movementError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Stock created but ledger write failed.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_plastic.receive',
        entityType: 'inventory_plastic_stock',
        entityId: stock.id,
        newValues: {
          stockCode: stock.stockCode,
          catalogItemId: stock.catalogItemId,
          boxes,
          sizeLabel: stock.sizeLabel,
        },
        ...meta,
      });
      return stock;
    },

    async listPlasticMovements(actor: RequestUser, stockId: string): Promise<InventoryPlasticMovement[]> {
      if (!canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the plastic ledger.', 403);
      }
      const { data: stock, error: stockError } = await supabase
        .from('inventory_plastic_stock')
        .select('id')
        .eq('id', stockId)
        .single();
      if (stockError || !stock) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Plastic stock not found.', 404);
      }
      const { data, error } = await supabase
        .from('inventory_plastic_movements')
        .select('*, employees(employee_code, full_name)')
        .eq('plastic_stock_id', stockId)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list plastic movements.', 500);
      }
      return ((data ?? []) as PlasticMovementRow[]).map(mapPlasticMovement);
    },

    async adjustPlasticStock(
      actor: RequestUser,
      id: string,
      input: { boxesOnHand: number; notes: string },
      meta: RequestMeta,
    ): Promise<InventoryPlasticStock> {
      if (!canAdjustPlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot adjust plastic stock.', 403);
      }
      const notes = input.notes.trim();
      if (notes.length < 3) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Adjustment reason is required.', 400);
      }
      const newBoxes = Math.trunc(Number(input.boxesOnHand));
      if (!Number.isFinite(newBoxes) || newBoxes < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Boxes on hand must be zero or a positive whole number.', 400);
      }

      const current = await this.getPlasticStock(actor, id);
      if (current.status === 'void') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Void stock cannot be adjusted.', 400);
      }
      if (newBoxes > current.boxesReceived) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Boxes on hand cannot exceed total boxes received on this line.',
          400,
        );
      }
      if (newBoxes === current.boxesOnHand) {
        return current;
      }

      const delta = Math.abs(newBoxes - current.boxesOnHand);
      const status: InventoryPlasticStockStatus = newBoxes === 0 ? 'depleted' : 'active';
      const { data: updated, error: updateError } = await supabase
        .from('inventory_plastic_stock')
        .update({ boxes_on_hand: newBoxes, status })
        .eq('id', id)
        .eq('boxes_on_hand', current.boxesOnHand)
        .select(PLASTIC_SELECT)
        .single();
      if (updateError || !updated) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Stock changed — refresh and try again.', 409);
      }

      await supabase.from('inventory_plastic_movements').insert({
        plastic_stock_id: id,
        movement_type: 'adjust',
        boxes: delta,
        boxes_before: current.boxesOnHand,
        boxes_after: newBoxes,
        unit: current.unit,
        employee_id: actor.employeeId,
        notes,
        created_by: actor.employeeId,
      });

      const mapped = mapPlasticStock(updated as PlasticStockRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_plastic.adjust',
        entityType: 'inventory_plastic_stock',
        entityId: id,
        oldValues: { boxesOnHand: current.boxesOnHand },
        newValues: { boxesOnHand: newBoxes, notes },
        ...meta,
      });
      return mapped;
    },

    async getPublicStationCard(token: string): Promise<InventoryPublicStationCard | null> {
      const qrToken = token.trim();
      if (!qrToken) return null;

      const { data, error } = await supabase
        .from('inventory_stations')
        .select(STATION_SELECT)
        .eq('qr_token', qrToken)
        .maybeSingle();
      if (error || !data) return null;

      const station = mapStation(data as StationRow);
      if (station.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This station QR is inactive.', 400);
      }

      const { data: stockRows, error: stockError } = await supabase
        .from('inventory_plastic_stock')
        .select(PLASTIC_SELECT)
        .eq('location_id', station.locationId)
        .eq('status', 'active')
        .gt('boxes_on_hand', 0)
        .order('created_at', { ascending: false });
      if (stockError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load plastic stock for station.', 500);
      }

      const items: InventoryPublicStationItem[] = ((stockRows ?? []) as PlasticStockRow[]).map((row) => {
        const stock = mapPlasticStock(row);
        return {
          id: stock.id,
          stockCode: stock.stockCode,
          itemName: stock.catalogItemName,
          manufacturer: stock.manufacturer,
          sizeLabel: stock.sizeLabel,
          boxesOnHand: stock.boxesOnHand,
          unit: stock.unit,
          qtyChips: stock.qtyChips.length ? stock.qtyChips : [...DEFAULT_BOX_CHIPS],
        };
      });

      return {
        kind: 'station',
        stationName: station.name,
        locationName: station.locationName,
        status: station.status,
        items,
        employees: await loadActiveEmployees(supabase),
      };
    },

    async publicIssuePlastic(
      token: string,
      input: { employeeId: string; plasticStockId: string; boxes: number; notes?: string },
      meta: RequestMeta = {},
    ): Promise<InventoryPublicPlasticIssueResult> {
      const qrToken = token.trim();
      const boxes = Math.trunc(Number(input.boxes));
      if (!Number.isFinite(boxes) || boxes <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Boxes must be a positive whole number.', 400);
      }
      if (!input.employeeId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an employee.', 400);
      }
      if (!input.plasticStockId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select a plastic item.', 400);
      }

      const { data: stationRow, error: stationError } = await supabase
        .from('inventory_stations')
        .select('id, location_id, status, qr_token')
        .eq('qr_token', qrToken)
        .single();
      if (stationError || !stationRow) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown or invalid station QR.', 404);
      }
      if (stationRow.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This station QR is inactive.', 400);
      }

      const { data: stockRow, error: stockError } = await supabase
        .from('inventory_plastic_stock')
        .select(PLASTIC_SELECT)
        .eq('id', input.plasticStockId)
        .single();
      if (stockError || !stockRow) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Plastic stock not found.', 404);
      }
      const stock = mapPlasticStock(stockRow as PlasticStockRow);
      if (stock.locationId !== stationRow.location_id) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'That item is not stocked at this station location.',
          400,
        );
      }
      if (stock.status === 'void') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This plastic stock is void.', 400);
      }
      if (stock.status === 'depleted' || stock.boxesOnHand <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This item has no boxes left.', 400);
      }

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, full_name, status, deleted_at')
        .eq('id', input.employeeId)
        .single();
      if (employeeError || !employee || employee.deleted_at || employee.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active employee.', 400);
      }

      const { data: rpcRows, error: rpcError } = await supabase.rpc('inventory_issue_plastic_boxes', {
        p_plastic_stock_id: stock.id,
        p_boxes: boxes,
        p_employee_id: input.employeeId,
        p_notes: (input.notes ?? '').trim() || 'Station issue',
        p_created_by: null,
        p_station_id: stationRow.id,
      });
      if (rpcError) {
        throw parseIssueRpcError(rpcError.message);
      }
      const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
      if (!rpc) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Issue did not return a result.', 500);
      }

      const boxesOnHand = asInt(rpc.boxes_on_hand);
      const unit = String(rpc.unit ?? stock.unit);

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'inventory_plastic.kiosk_issue',
        entityType: 'inventory_plastic_stock',
        entityId: stock.id,
        newValues: {
          stockCode: stock.stockCode,
          stationId: stationRow.id,
          employeeId: input.employeeId,
          employeeName: employee.full_name,
          boxes,
          boxesOnHand,
          unit,
          notes: (input.notes ?? '').trim() || 'Station issue',
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return {
        stockCode: stock.stockCode,
        itemName: stock.catalogItemName,
        sizeLabel: stock.sizeLabel,
        boxesIssued: boxes,
        boxesOnHand,
        unit,
        employeeName: employee.full_name,
      };
    },
  };
}
