import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canAdjustLots, canManageLots, type RequestMeta } from './access';
import type {
  InventoryEmployeeOption,
  InventoryLot,
  InventoryLotExpense,
  InventoryLotOrigin,
  InventoryLotPrint,
  InventoryLotStatus,
  InventoryMovement,
  InventoryPublicIssueResult,
  InventoryPublicScanCard,
  InventorySupplierType,
} from './types';

const MAX_QTY_CHIPS = 15;
/** Phase 2 measured + Phase 3 bought reagents (prep-origin lots come from prep-service). */
const RECEIVE_CATEGORY_CODES = new Set(['MATERIALS', 'CHEMICALS', 'SOLVENTS', 'REAGENTS']);

type LotRow = {
  id: string;
  lot_code: string;
  qr_token: string;
  catalog_item_id: string;
  location_id: string;
  supplier_name: string;
  supplier_type: InventorySupplierType;
  purchase_date: string;
  received_qty: number | string;
  remaining_qty: number | string;
  unit: string;
  total_cost: number | string;
  component_cost_total?: number | string | null;
  origin?: InventoryLotOrigin | null;
  counts_toward_purchase_expense?: boolean | null;
  prep_session_id?: string | null;
  expiry_date: string | null;
  qty_chips: unknown;
  status: InventoryLotStatus;
  notes: string;
  received_by: string | null;
  created_at: string;
  updated_at: string;
  inventory_catalog_items?:
    | {
        id: string;
        name: string;
        category_id: string;
        inventory_categories?: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
      }
    | {
        id: string;
        name: string;
        category_id: string;
        inventory_categories?: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
      }[]
    | null;
  inventory_locations?:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
};

type MovementRow = {
  id: string;
  lot_id: string;
  movement_type: 'receive' | 'issue' | 'adjust';
  qty: number | string;
  qty_before: number | string;
  qty_after: number | string;
  unit: string;
  employee_id: string | null;
  notes: string;
  created_by: string | null;
  prep_session_id?: string | null;
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

function parseQtyChips(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeQtyChips(input: unknown): number[] {
  if (input === undefined || input === null) return [];
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
    if (!Number.isFinite(num) || num <= 0) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Each qty chip must be a positive number.', 400);
    }
    const rounded = Math.round(num * 10000) / 10000;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    chips.push(rounded);
  }
  return chips;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function mapLot(row: LotRow): InventoryLot {
  const catalog = one(row.inventory_catalog_items);
  const category = one(catalog?.inventory_categories ?? null);
  const location = one(row.inventory_locations);
  const origin: InventoryLotOrigin = row.origin === 'prep' ? 'prep' : 'purchase';
  const countsTowardPurchaseExpense =
    row.counts_toward_purchase_expense === undefined || row.counts_toward_purchase_expense === null
      ? origin === 'purchase'
      : Boolean(row.counts_toward_purchase_expense);
  return {
    id: row.id,
    lotCode: row.lot_code,
    qrToken: row.qr_token,
    catalogItemId: row.catalog_item_id,
    catalogItemName: catalog?.name ?? '',
    categoryId: category?.id ?? catalog?.category_id ?? '',
    categoryCode: category?.code ?? '',
    categoryName: category?.name ?? '',
    locationId: row.location_id,
    locationCode: location?.code ?? '',
    locationName: location?.name ?? '',
    supplierName: row.supplier_name,
    supplierType: row.supplier_type,
    purchaseDate: row.purchase_date,
    receivedQty: asNumber(row.received_qty),
    remainingQty: asNumber(row.remaining_qty),
    unit: row.unit,
    totalCost: asNumber(row.total_cost),
    componentCostTotal: asNumber(row.component_cost_total),
    origin,
    countsTowardPurchaseExpense,
    prepSessionId: row.prep_session_id ?? null,
    expiryDate: row.expiry_date,
    qtyChips: parseQtyChips(row.qty_chips),
    status: row.status,
    notes: row.notes,
    receivedBy: row.received_by,
    scanPath: `/scan/${row.qr_token}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lotExpenseOf(lot: InventoryLot): InventoryLotExpense {
  const purchaseExpense = lot.totalCost;
  const componentExpense = lot.componentCostTotal;
  if (lot.origin === 'prep' || !lot.countsTowardPurchaseExpense) {
    return {
      lotId: lot.id,
      lotCode: lot.lotCode,
      origin: lot.origin,
      purchaseExpense,
      componentExpense,
      reportableExpense: componentExpense,
      note: 'Lab-made reagent: reportable spend is component (chemical/solvent) cost only — purchase cost excluded.',
    };
  }
  return {
    lotId: lot.id,
    lotCode: lot.lotCode,
    origin: lot.origin,
    purchaseExpense,
    componentExpense,
    reportableExpense: purchaseExpense,
    note: 'Purchased lot: reportable spend is the entered purchase cost.',
  };
}

function mapMovement(row: MovementRow): InventoryMovement {
  const employee = one(row.employees);
  return {
    id: row.id,
    lotId: row.lot_id,
    movementType: row.movement_type,
    qty: asNumber(row.qty),
    qtyBefore: asNumber(row.qty_before),
    qtyAfter: asNumber(row.qty_after),
    unit: row.unit,
    employeeId: row.employee_id,
    employeeCode: employee?.employee_code ?? null,
    employeeName: employee?.full_name ?? null,
    notes: row.notes,
    createdBy: row.created_by,
    prepSessionId: row.prep_session_id ?? null,
    createdAt: row.created_at,
  };
}

const LOT_SELECT =
  '*, inventory_catalog_items(id, name, category_id, inventory_categories(id, code, name)), inventory_locations(code, name)';

function newQrToken(): string {
  return randomBytes(24).toString('base64url');
}

function newLotCode(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `LOT-${y}${m}${d}-${suffix}`;
}

function parseIssueRpcError(message: string | undefined): AppError {
  const text = message ?? '';
  if (text.includes('OVER_ISSUE')) {
    const match = text.match(/OVER_ISSUE:([0-9.]+)/);
    const remaining = match?.[1] ?? '?';
    return new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `Quantity exceeds remaining stock (${remaining}).`,
      400,
    );
  }
  if (text.includes('LOT_NOT_FOUND')) {
    return new AppError(API_ERROR_CODES.NOT_FOUND, 'Lot not found.', 404);
  }
  if (text.includes('LOT_VOID')) {
    return new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This lot is void and cannot be issued.', 400);
  }
  if (text.includes('ISSUE_QTY_INVALID')) {
    return new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Issue quantity must be positive.', 400);
  }
  return new AppError(API_ERROR_CODES.INTERNAL_ERROR, message ?? 'Unable to issue from lot.', 500);
}

export function createInventoryLotsService(supabase: SupabaseClient) {
  return {
    async listLots(actor: RequestUser): Promise<InventoryLot[]> {
      if (!canManageLots(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view lots.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_lots')
        .select(LOT_SELECT)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list lots.', 500);
      }
      return ((data ?? []) as LotRow[]).map(mapLot);
    },

    async getLot(actor: RequestUser, id: string): Promise<InventoryLot> {
      if (!canManageLots(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view lots.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_lots')
        .select(LOT_SELECT)
        .eq('id', id)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Lot not found.', 404);
      }
      return mapLot(data as LotRow);
    },

    async receiveLot(
      actor: RequestUser,
      input: {
        catalogItemId: string;
        locationId: string;
        supplierName?: string;
        supplierType?: InventorySupplierType;
        purchaseDate: string;
        qty: number;
        unit?: string;
        totalCost?: number;
        expiryDate?: string | null;
        qtyChips?: number[];
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<InventoryLot> {
      if (!canManageLots(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot receive lots.', 403);
      }

      const qty = Number(input.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Received quantity must be positive.', 400);
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
      if (!category || category.deduction_mode !== 'measured') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only measured categories can use this receipt form.',
          400,
        );
      }
      if (!RECEIVE_CATEGORY_CODES.has(category.code)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Plastic ware receipts land in a later phase. Use Materials, Chemicals, Solvents, or Reagents.',
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

      const chips =
        input.qtyChips !== undefined
          ? normalizeQtyChips(input.qtyChips)
          : parseQtyChips(catalog.default_qty_chips);
      const unit = (input.unit ?? catalog.unit).trim();
      if (!unit) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unit is required.', 400);
      }
      const totalCost = Number(input.totalCost ?? 0);
      if (!Number.isFinite(totalCost) || totalCost < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Total cost must be zero or positive.', 400);
      }

      const isReagent = category.code === 'REAGENTS';
      const supplierType = input.supplierType ?? 'external';
      const lotCode = newLotCode();
      const qrToken = newQrToken();
      const { data: inserted, error: insertError } = await supabase
        .from('inventory_lots')
        .insert({
          lot_code: lotCode,
          qr_token: qrToken,
          catalog_item_id: input.catalogItemId,
          location_id: input.locationId,
          supplier_name:
            (input.supplierName ?? '').trim() ||
            (isReagent && supplierType === 'internal' ? 'Internal' : ''),
          supplier_type: supplierType,
          purchase_date: input.purchaseDate,
          received_qty: qty,
          remaining_qty: qty,
          unit,
          total_cost: totalCost,
          component_cost_total: 0,
          origin: 'purchase',
          counts_toward_purchase_expense: true,
          prep_session_id: null,
          expiry_date: input.expiryDate || null,
          qty_chips: chips,
          notes: (input.notes ?? '').trim(),
          received_by: actor.employeeId,
          status: 'active',
        })
        .select(LOT_SELECT)
        .single();
      if (insertError || !inserted) {
        if (insertError?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'Lot code collision — please retry.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, insertError?.message ?? 'Failed to receive lot.', 500);
      }

      const lot = mapLot(inserted as LotRow);
      const { error: movementError } = await supabase.from('inventory_movements').insert({
        lot_id: lot.id,
        movement_type: 'receive',
        qty,
        qty_before: 0,
        qty_after: qty,
        unit,
        employee_id: actor.employeeId,
        notes: 'Receipt',
        created_by: actor.employeeId,
      });
      if (movementError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Lot created but ledger write failed.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lot.receive',
        entityType: 'inventory_lot',
        entityId: lot.id,
        newValues: {
          lotCode: lot.lotCode,
          catalogItemId: lot.catalogItemId,
          qty,
          unit,
          locationId: lot.locationId,
        },
        ...meta,
      });
      return lot;
    },

    async getLotPrint(
      actor: RequestUser,
      id: string,
      siteUrl: string,
    ): Promise<InventoryLotPrint> {
      const lot = await this.getLot(actor, id);
      const base = siteUrl.replace(/\/$/, '');
      return {
        lot,
        scanUrl: `${base}${lot.scanPath}`,
        labelTitle: `${lot.catalogItemName} · ${lot.lotCode}`,
      };
    },

    async getLotExpense(actor: RequestUser, id: string): Promise<InventoryLotExpense> {
      const lot = await this.getLot(actor, id);
      return lotExpenseOf(lot);
    },

    async listMovements(actor: RequestUser, lotId: string): Promise<InventoryMovement[]> {
      if (!canManageLots(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the movement ledger.', 403);
      }
      const { data: lot, error: lotError } = await supabase
        .from('inventory_lots')
        .select('id')
        .eq('id', lotId)
        .single();
      if (lotError || !lot) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Lot not found.', 404);
      }
      const { data, error } = await supabase
        .from('inventory_movements')
        .select('*, employees(employee_code, full_name)')
        .eq('lot_id', lotId)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list movements.', 500);
      }
      return ((data ?? []) as MovementRow[]).map(mapMovement);
    },

    async adjustLot(
      actor: RequestUser,
      id: string,
      input: { remainingQty: number; notes: string },
      meta: RequestMeta,
    ): Promise<InventoryLot> {
      if (!canAdjustLots(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot adjust lot quantities.', 403);
      }
      const notes = input.notes.trim();
      if (notes.length < 3) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Adjustment reason is required.', 400);
      }
      const newQty = Number(input.remainingQty);
      if (!Number.isFinite(newQty) || newQty < 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Remaining quantity must be zero or positive.', 400);
      }

      const { data: current, error: currentError } = await supabase
        .from('inventory_lots')
        .select(LOT_SELECT)
        .eq('id', id)
        .single();
      if (currentError || !current) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Lot not found.', 404);
      }
      const lot = mapLot(current as LotRow);
      if (lot.status === 'void') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Void lots cannot be adjusted.', 400);
      }
      if (newQty > lot.receivedQty) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Remaining quantity cannot exceed original received quantity.',
          400,
        );
      }
      if (newQty === lot.remainingQty) {
        return lot;
      }

      const delta = Math.abs(newQty - lot.remainingQty);
      const status: InventoryLotStatus = newQty === 0 ? 'depleted' : 'active';
      const { data: updated, error: updateError } = await supabase
        .from('inventory_lots')
        .update({ remaining_qty: newQty, status })
        .eq('id', id)
        .eq('remaining_qty', lot.remainingQty)
        .select(LOT_SELECT)
        .single();
      if (updateError || !updated) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Lot changed — refresh and try again.', 409);
      }

      await supabase.from('inventory_movements').insert({
        lot_id: id,
        movement_type: 'adjust',
        qty: delta,
        qty_before: lot.remainingQty,
        qty_after: newQty,
        unit: lot.unit,
        employee_id: actor.employeeId,
        notes,
        created_by: actor.employeeId,
      });

      const mapped = mapLot(updated as LotRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_lot.adjust',
        entityType: 'inventory_lot',
        entityId: id,
        oldValues: { remainingQty: lot.remainingQty },
        newValues: { remainingQty: newQty, notes },
        ...meta,
      });
      return mapped;
    },

    async getPublicScanCard(token: string): Promise<InventoryPublicScanCard> {
      const qrToken = token.trim();
      if (!qrToken) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Scan token not found.', 404);
      }
      const { data, error } = await supabase
        .from('inventory_lots')
        .select(LOT_SELECT)
        .eq('qr_token', qrToken)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown or invalid QR code.', 404);
      }
      const lot = mapLot(data as LotRow);

      const { data: employees, error: employeesError } = await supabase
        .from('employees')
        .select('id, employee_code, full_name, email')
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('full_name');
      if (employeesError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee list.', 500);
      }

      const options: InventoryEmployeeOption[] = ((employees ?? []) as Array<{
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

      return {
        kind: 'lot' as const,
        lotCode: lot.lotCode,
        itemName: lot.catalogItemName,
        categoryName: lot.categoryName,
        locationName: lot.locationName,
        unit: lot.unit,
        remainingQty: lot.remainingQty,
        qtyChips: lot.qtyChips,
        expiryDate: lot.expiryDate,
        status: lot.status,
        employees: options,
      };
    },

    async publicIssue(
      token: string,
      input: { employeeId: string; qty: number; notes?: string },
      meta: RequestMeta = {},
    ): Promise<InventoryPublicIssueResult> {
      const qrToken = token.trim();
      const qty = Number(input.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Quantity must be positive.', 400);
      }
      if (!input.employeeId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an employee.', 400);
      }

      const { data: lotRow, error: lotError } = await supabase
        .from('inventory_lots')
        .select('id, lot_code, remaining_qty, unit, status, qr_token')
        .eq('qr_token', qrToken)
        .single();
      if (lotError || !lotRow) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown or invalid QR code.', 404);
      }
      if (lotRow.status === 'void') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This lot is void.', 400);
      }
      if (lotRow.status === 'depleted' || asNumber(lotRow.remaining_qty) <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This lot has no remaining stock.', 400);
      }

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, full_name, status, deleted_at')
        .eq('id', input.employeeId)
        .single();
      if (employeeError || !employee || employee.deleted_at || employee.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active employee.', 400);
      }

      const { data: auth } = await supabase
        .from('inventory_authorizations')
        .select('can_usage')
        .eq('employee_id', input.employeeId)
        .maybeSingle();
      if (!auth?.can_usage) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Not authorized — ask Inventory Manager.',
          403,
        );
      }

      const { data: rpcRows, error: rpcError } = await supabase.rpc('inventory_issue_lot', {
        p_lot_id: lotRow.id,
        p_qty: qty,
        p_employee_id: input.employeeId,
        p_notes: (input.notes ?? '').trim() || 'Kiosk issue',
        p_created_by: null,
        p_prep_session_id: null,
      });
      if (rpcError) {
        throw parseIssueRpcError(rpcError.message);
      }
      const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
      if (!rpc) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Issue did not return a result.', 500);
      }

      const remainingQty = asNumber(rpc.remaining_qty);
      const unit = String(rpc.unit ?? lotRow.unit);

      await writeAuditLog(supabase, {
        actorId: null,
        action: 'inventory_lot.kiosk_issue',
        entityType: 'inventory_lot',
        entityId: String(lotRow.id),
        newValues: {
          lotCode: lotRow.lot_code,
          employeeId: input.employeeId,
          employeeName: employee.full_name,
          qty,
          remainingQty,
          unit,
          notes: (input.notes ?? '').trim() || 'Kiosk issue',
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return {
        lotCode: lotRow.lot_code,
        qtyIssued: qty,
        remainingQty,
        unit,
        employeeName: employee.full_name,
      };
    },
  };
}
