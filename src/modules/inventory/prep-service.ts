import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { canManagePrep, type RequestMeta } from './access';
import type {
  InventoryPrepInput,
  InventoryPrepSession,
  InventoryPrepStatus,
} from './types';

const MAX_QTY_CHIPS = 15;
const PREP_INPUT_CATEGORY_CODES = new Set(['CHEMICALS', 'SOLVENTS']);

type PrepSessionRow = {
  id: string;
  catalog_item_id: string;
  location_id: string;
  target_qty: number | string;
  unit: string;
  qty_chips: unknown;
  status: InventoryPrepStatus;
  notes: string;
  prepared_by: string | null;
  reagent_lot_id: string | null;
  component_cost_total: number | string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  inventory_catalog_items?:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null;
  inventory_locations?:
    | { name: string }
    | { name: string }[]
    | null;
};

type PrepInputRow = {
  id: string;
  prep_session_id: string;
  source_lot_id: string;
  movement_id: string;
  qty: number | string;
  unit: string;
  attributed_cost: number | string;
  created_at: string;
  inventory_lots?:
    | {
        lot_code: string;
        inventory_catalog_items?:
          | { name: string }
          | { name: string }[]
          | null;
      }
    | {
        lot_code: string;
        inventory_catalog_items?:
          | { name: string }
          | { name: string }[]
          | null;
      }[]
    | null;
};

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
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
    return new AppError(API_ERROR_CODES.NOT_FOUND, 'Source lot not found.', 404);
  }
  if (text.includes('LOT_VOID')) {
    return new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Source lot is void.', 400);
  }
  if (text.includes('ISSUE_QTY_INVALID')) {
    return new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Issue quantity must be positive.', 400);
  }
  return new AppError(API_ERROR_CODES.INTERNAL_ERROR, message ?? 'Unable to issue for prep.', 500);
}

function mapInput(row: PrepInputRow): InventoryPrepInput {
  const lot = one(row.inventory_lots);
  const catalog = one(lot?.inventory_catalog_items ?? null);
  return {
    id: row.id,
    prepSessionId: row.prep_session_id,
    sourceLotId: row.source_lot_id,
    sourceLotCode: lot?.lot_code ?? '',
    sourceItemName: catalog?.name ?? '',
    movementId: row.movement_id,
    qty: asNumber(row.qty),
    unit: row.unit,
    attributedCost: asNumber(row.attributed_cost),
    createdAt: row.created_at,
  };
}

function mapSession(
  row: PrepSessionRow,
  inputs: InventoryPrepInput[],
  reagentLotCode: string | null = null,
): InventoryPrepSession {
  const catalog = one(row.inventory_catalog_items);
  const location = one(row.inventory_locations);
  return {
    id: row.id,
    catalogItemId: row.catalog_item_id,
    catalogItemName: catalog?.name ?? '',
    locationId: row.location_id,
    locationName: location?.name ?? '',
    targetQty: asNumber(row.target_qty),
    unit: row.unit,
    qtyChips: parseQtyChips(row.qty_chips),
    status: row.status,
    notes: row.notes,
    preparedBy: row.prepared_by,
    reagentLotId: row.reagent_lot_id,
    reagentLotCode,
    componentCostTotal: asNumber(row.component_cost_total),
    inputs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const SESSION_SELECT = '*, inventory_catalog_items(id, name), inventory_locations(name)';

const INPUT_SELECT =
  '*, inventory_lots(lot_code, inventory_catalog_items(name))';

export function createInventoryPrepService(supabase: SupabaseClient) {
  async function loadInputs(sessionId: string): Promise<InventoryPrepInput[]> {
    const { data, error } = await supabase
      .from('inventory_prep_inputs')
      .select(INPUT_SELECT)
      .eq('prep_session_id', sessionId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load prep inputs.', 500);
    }
    return ((data ?? []) as PrepInputRow[]).map(mapInput);
  }

  async function resolveReagentLotCode(reagentLotId: string | null): Promise<string | null> {
    if (!reagentLotId) return null;
    const { data } = await supabase
      .from('inventory_lots')
      .select('lot_code')
      .eq('id', reagentLotId)
      .maybeSingle();
    return data?.lot_code ?? null;
  }

  async function loadSession(id: string): Promise<InventoryPrepSession> {
    const { data, error } = await supabase
      .from('inventory_prep_sessions')
      .select(SESSION_SELECT)
      .eq('id', id)
      .single();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Prep session not found.', 404);
    }
    const row = data as PrepSessionRow;
    const [inputs, reagentLotCode] = await Promise.all([
      loadInputs(id),
      resolveReagentLotCode(row.reagent_lot_id),
    ]);
    return mapSession(row, inputs, reagentLotCode);
  }

  return {
    async listPrepSessions(actor: RequestUser): Promise<InventoryPrepSession[]> {
      if (!canManagePrep(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view prep sessions.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_prep_sessions')
        .select(SESSION_SELECT)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list prep sessions.', 500);
      }
      const rows = (data ?? []) as PrepSessionRow[];
      const sessions: InventoryPrepSession[] = [];
      for (const row of rows) {
        const [inputs, reagentLotCode] = await Promise.all([
          loadInputs(row.id),
          resolveReagentLotCode(row.reagent_lot_id),
        ]);
        sessions.push(mapSession(row, inputs, reagentLotCode));
      }
      return sessions;
    },

    async getPrepSession(actor: RequestUser, id: string): Promise<InventoryPrepSession> {
      if (!canManagePrep(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view prep sessions.', 403);
      }
      return loadSession(id);
    },

    async createPrepSession(
      actor: RequestUser,
      input: {
        catalogItemId: string;
        locationId: string;
        targetQty: number;
        unit?: string;
        qtyChips?: number[];
        notes?: string;
      },
      meta: RequestMeta,
    ): Promise<InventoryPrepSession> {
      if (!canManagePrep(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot open prep sessions.', 403);
      }

      const targetQty = Number(input.targetQty);
      if (!Number.isFinite(targetQty) || targetQty <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Target quantity must be positive.', 400);
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
      if (!category || category.code !== 'REAGENTS' || category.deduction_mode !== 'measured') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Prep sessions are only for Reagents catalog items.',
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

      const { data: inserted, error: insertError } = await supabase
        .from('inventory_prep_sessions')
        .insert({
          catalog_item_id: input.catalogItemId,
          location_id: input.locationId,
          target_qty: targetQty,
          unit,
          qty_chips: chips,
          notes: (input.notes ?? '').trim(),
          prepared_by: actor.employeeId,
          status: 'open',
          component_cost_total: 0,
        })
        .select(SESSION_SELECT)
        .single();
      if (insertError || !inserted) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          insertError?.message ?? 'Failed to open prep session.',
          500,
        );
      }

      const session = mapSession(inserted as PrepSessionRow, []);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_prep.create',
        entityType: 'inventory_prep_session',
        entityId: session.id,
        newValues: {
          catalogItemId: session.catalogItemId,
          targetQty: session.targetQty,
          unit: session.unit,
        },
        ...meta,
      });
      return session;
    },

    async addPrepInput(
      actor: RequestUser,
      sessionId: string,
      input: { sourceLotId: string; qty: number; notes?: string },
      meta: RequestMeta,
    ): Promise<InventoryPrepSession> {
      if (!canManagePrep(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot add prep inputs.', 403);
      }
      if (!actor.employeeId) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Your account must be linked to an employee to issue for prep.',
          400,
        );
      }

      const qty = Number(input.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Quantity must be positive.', 400);
      }

      const session = await loadSession(sessionId);
      if (session.status !== 'open') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only open prep sessions accept inputs.', 400);
      }

      const { data: sourceLot, error: sourceError } = await supabase
        .from('inventory_lots')
        .select(
          'id, lot_code, remaining_qty, unit, status, inventory_catalog_items(name, inventory_categories(code))',
        )
        .eq('id', input.sourceLotId)
        .single();
      if (sourceError || !sourceLot) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown source lot.', 400);
      }
      if (sourceLot.status === 'void') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Source lot is void.', 400);
      }
      if (sourceLot.status === 'depleted' || asNumber(sourceLot.remaining_qty) <= 0) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Source lot has no remaining stock.', 400);
      }
      const catalog = one(
        sourceLot.inventory_catalog_items as
          | { name: string; inventory_categories?: { code: string } | { code: string }[] | null }
          | { name: string; inventory_categories?: { code: string } | { code: string }[] | null }[]
          | null,
      );
      const category = one(catalog?.inventory_categories ?? null);
      if (!category || !PREP_INPUT_CATEGORY_CODES.has(category.code)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Prep inputs must come from Chemicals or Solvents lots.',
          400,
        );
      }

      const { data: rpcRows, error: rpcError } = await supabase.rpc('inventory_issue_lot', {
        p_lot_id: input.sourceLotId,
        p_qty: qty,
        p_employee_id: actor.employeeId,
        p_notes: (input.notes ?? '').trim() || `Prep ${session.catalogItemName}`,
        p_created_by: actor.employeeId,
        p_prep_session_id: sessionId,
      });
      if (rpcError) {
        throw parseIssueRpcError(rpcError.message);
      }
      const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
      if (!rpc?.movement_id) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Issue did not return a movement.', 500);
      }

      const attributedCost = asNumber(rpc.attributed_cost);
      const { error: inputError } = await supabase.from('inventory_prep_inputs').insert({
        prep_session_id: sessionId,
        source_lot_id: input.sourceLotId,
        movement_id: rpc.movement_id,
        qty,
        unit: String(rpc.unit ?? sourceLot.unit),
        attributed_cost: attributedCost,
      });
      if (inputError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Issue recorded but prep input failed.', 500);
      }

      const newTotal = Math.round((session.componentCostTotal + attributedCost) * 10000) / 10000;
      const { error: updateError } = await supabase
        .from('inventory_prep_sessions')
        .update({ component_cost_total: newTotal })
        .eq('id', sessionId)
        .eq('status', 'open');
      if (updateError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update prep cost total.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_prep.add_input',
        entityType: 'inventory_prep_session',
        entityId: sessionId,
        newValues: {
          sourceLotId: input.sourceLotId,
          qty,
          attributedCost,
        },
        ...meta,
      });

      return loadSession(sessionId);
    },

    async completePrepSession(
      actor: RequestUser,
      sessionId: string,
      input: { expiryDate?: string | null; notes?: string } | undefined,
      meta: RequestMeta,
    ): Promise<InventoryPrepSession> {
      if (!canManagePrep(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot complete prep sessions.', 403);
      }

      const session = await loadSession(sessionId);
      if (session.status !== 'open') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only open prep sessions can be completed.', 400);
      }
      if (session.inputs.length === 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Add at least one chemical/solvent issue before completing prep.',
          400,
        );
      }

      const lotCode = newLotCode();
      const qrToken = newQrToken();
      const purchaseDate = new Date().toISOString().slice(0, 10);
      const notes =
        (input?.notes ?? '').trim() ||
        session.notes ||
        `Lab prep · session ${session.id.slice(0, 8)}`;

      const { data: insertedLot, error: lotError } = await supabase
        .from('inventory_lots')
        .insert({
          lot_code: lotCode,
          qr_token: qrToken,
          catalog_item_id: session.catalogItemId,
          location_id: session.locationId,
          supplier_name: 'Lab prep',
          supplier_type: 'internal',
          purchase_date: purchaseDate,
          received_qty: session.targetQty,
          remaining_qty: session.targetQty,
          unit: session.unit,
          total_cost: 0,
          component_cost_total: session.componentCostTotal,
          origin: 'prep',
          counts_toward_purchase_expense: false,
          prep_session_id: sessionId,
          expiry_date: input?.expiryDate || null,
          qty_chips: session.qtyChips,
          notes,
          received_by: actor.employeeId,
          status: 'active',
        })
        .select('id, lot_code')
        .single();
      if (lotError || !insertedLot) {
        if (lotError?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'Lot code collision — please retry.', 409);
        }
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          lotError?.message ?? 'Failed to create reagent lot.',
          500,
        );
      }

      const { error: movementError } = await supabase.from('inventory_movements').insert({
        lot_id: insertedLot.id,
        movement_type: 'receive',
        qty: session.targetQty,
        qty_before: 0,
        qty_after: session.targetQty,
        unit: session.unit,
        employee_id: actor.employeeId,
        notes: 'Lab prep complete',
        created_by: actor.employeeId,
        prep_session_id: sessionId,
      });
      if (movementError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Reagent lot created but ledger write failed.', 500);
      }

      const completedAt = new Date().toISOString();
      const { error: completeError } = await supabase
        .from('inventory_prep_sessions')
        .update({
          status: 'completed',
          reagent_lot_id: insertedLot.id,
          completed_at: completedAt,
          notes: notes,
        })
        .eq('id', sessionId)
        .eq('status', 'open');
      if (completeError) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Prep session changed — refresh and try again.', 409);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_prep.complete',
        entityType: 'inventory_prep_session',
        entityId: sessionId,
        newValues: {
          reagentLotId: insertedLot.id,
          lotCode: insertedLot.lot_code,
          componentCostTotal: session.componentCostTotal,
        },
        ...meta,
      });

      return loadSession(sessionId);
    },

    async cancelPrepSession(
      actor: RequestUser,
      sessionId: string,
      meta: RequestMeta,
    ): Promise<InventoryPrepSession> {
      if (!canManagePrep(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot cancel prep sessions.', 403);
      }

      const session = await loadSession(sessionId);
      if (session.status !== 'open') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only open prep sessions can be cancelled.', 400);
      }
      if (session.inputs.length > 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Cannot cancel after chemical/solvent issues. Complete the prep or leave the session open.',
          400,
        );
      }

      const { error } = await supabase
        .from('inventory_prep_sessions')
        .update({ status: 'cancelled', completed_at: new Date().toISOString() })
        .eq('id', sessionId)
        .eq('status', 'open');
      if (error) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Prep session changed — refresh and try again.', 409);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'inventory_prep.cancel',
        entityType: 'inventory_prep_session',
        entityId: sessionId,
        ...meta,
      });

      return loadSession(sessionId);
    },
  };
}
