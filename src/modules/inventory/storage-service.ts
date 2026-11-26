import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { canManageLots, canManagePlastic } from './access';
import { createInventoryCentralQrsService } from './central-qrs-service';
import type {
  InventoryStorageArea,
  InventoryStorageKind,
  InventoryStorageLotRow,
  InventoryStorageMovementRow,
  InventoryStoragePlasticRow,
} from './types';

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

const AREA_COPY: Record<InventoryStorageKind, string> = {
  stock_room:
    'Unopened plasticware, chemicals, and reagents. Plastic boxes are taken out here. Chemicals/reagents transfer to Inside lab before unit consumption.',
  inside_lab:
    'Chemicals and reagents after transfer from Stock room. Unit-level consumption happens here via Inside lab scan / work types.',
  stationery: 'Stationery and miscellaneous box stock. Take-out deducts boxes from this area only.',
};

export function createInventoryStorageService(supabase: SupabaseClient) {
  return {
    async getArea(actor: RequestUser, kind: InventoryStorageKind): Promise<InventoryStorageArea> {
      if (!canManageLots(actor) && !canManagePlastic(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view storage.', 403);
      }
      if (kind !== 'stock_room' && kind !== 'inside_lab' && kind !== 'stationery') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown storage area.', 400);
      }

      const central = await createInventoryCentralQrsService(supabase).getByKind(kind);
      const lots: InventoryStorageLotRow[] = [];
      const plastic: InventoryStoragePlasticRow[] = [];
      const recentMovements: InventoryStorageMovementRow[] = [];

      if (kind !== 'stationery' && canManageLots(actor)) {
        const { data: lotRows, error: lotError } = await supabase
          .from('inventory_lots')
          .select(
            'id, lot_code, remaining_qty, received_qty, unit, status, purchase_date, expiry_date, inventory_catalog_items(name, catalog_number, inventory_categories(name)), inventory_locations(name)',
          )
          .eq('central_qr_id', central.id)
          .neq('status', 'void')
          .order('created_at', { ascending: false });
        if (lotError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load storage lots.', 500);
        }
        for (const row of (lotRows ?? []) as Array<Record<string, unknown>>) {
          const catalog = one(
            row.inventory_catalog_items as
              | { name: string; catalog_number?: string | null; inventory_categories?: { name: string } | { name: string }[] | null }
              | { name: string; catalog_number?: string | null; inventory_categories?: { name: string } | { name: string }[] | null }[]
              | null,
          );
          const category = one(catalog?.inventory_categories ?? null);
          const location = one(row.inventory_locations as { name: string } | { name: string }[] | null);
          const remainingQty = asNumber(row.remaining_qty as number | string);
          lots.push({
            id: String(row.id),
            lotCode: String(row.lot_code),
            catalogItemName: catalog?.name ?? '',
            categoryName: category?.name ?? '',
            catalogNumber: (catalog?.catalog_number ?? '').trim(),
            remainingQty,
            receivedQty: asNumber(row.received_qty as number | string),
            unit: String(row.unit),
            status: row.status as InventoryStorageLotRow['status'],
            locationName: location?.name ?? '',
            purchaseDate: String(row.purchase_date ?? ''),
            expiryDate: (row.expiry_date as string | null) ?? null,
            canTransferToInsideLab: kind === 'stock_room' && row.status === 'active' && remainingQty > 0,
          });
        }
      }

      if (kind !== 'inside_lab' && canManagePlastic(actor)) {
        const { data: plasticRows, error: plasticError } = await supabase
          .from('inventory_plastic_stock')
          .select(
            'id, stock_code, manufacturer, size_label, boxes_on_hand, boxes_received, unit, inventory_catalog_items(name, inventory_categories(name)), inventory_locations(name)',
          )
          .eq('central_qr_id', central.id)
          .neq('status', 'void')
          .order('created_at', { ascending: false });
        if (plasticError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load storage boxes.', 500);
        }
        for (const row of (plasticRows ?? []) as Array<Record<string, unknown>>) {
          const catalog = one(
            row.inventory_catalog_items as
              | { name: string; inventory_categories?: { name: string } | { name: string }[] | null }
              | { name: string; inventory_categories?: { name: string } | { name: string }[] | null }[]
              | null,
          );
          const category = one(catalog?.inventory_categories ?? null);
          const location = one(row.inventory_locations as { name: string } | { name: string }[] | null);
          plastic.push({
            id: String(row.id),
            stockCode: String(row.stock_code),
            catalogItemName: catalog?.name ?? '',
            categoryName: category?.name ?? '',
            manufacturer: String(row.manufacturer ?? ''),
            sizeLabel: String(row.size_label ?? ''),
            boxesOnHand: Math.trunc(asNumber(row.boxes_on_hand as number | string)),
            boxesReceived: Math.trunc(asNumber(row.boxes_received as number | string)),
            unit: String(row.unit),
            locationName: location?.name ?? '',
          });
        }
      }

      if (canManageLots(actor) && lots.length) {
        const lotIds = lots.map((row) => row.id);
        const { data: lotMoves } = await supabase
          .from('inventory_movements')
          .select('id, lot_id, movement_type, qty, unit, notes, created_at, employees(full_name), inventory_lots(lot_code)')
          .in('lot_id', lotIds)
          .order('created_at', { ascending: false })
          .limit(40);
        for (const row of (lotMoves ?? []) as Array<Record<string, unknown>>) {
          const employee = one(row.employees as { full_name: string } | { full_name: string }[] | null);
          const lot = one(row.inventory_lots as { lot_code: string } | { lot_code: string }[] | null);
          recentMovements.push({
            id: String(row.id),
            movementType: String(row.movement_type),
            source: 'lot',
            label: lot?.lot_code ?? String(row.lot_id),
            qty: asNumber(row.qty as number | string),
            unit: String(row.unit),
            notes: String(row.notes ?? ''),
            employeeName: employee?.full_name ?? '',
            createdAt: String(row.created_at),
          });
        }
      }

      if (canManagePlastic(actor) && plastic.length) {
        const plasticIds = plastic.map((row) => row.id);
        const { data: plasticMoves } = await supabase
          .from('inventory_plastic_movements')
          .select(
            'id, plastic_stock_id, movement_type, boxes, unit, notes, created_at, employees(full_name), inventory_plastic_stock(stock_code)',
          )
          .in('plastic_stock_id', plasticIds)
          .order('created_at', { ascending: false })
          .limit(40);
        for (const row of (plasticMoves ?? []) as Array<Record<string, unknown>>) {
          const employee = one(row.employees as { full_name: string } | { full_name: string }[] | null);
          const stock = one(
            row.inventory_plastic_stock as { stock_code: string } | { stock_code: string }[] | null,
          );
          recentMovements.push({
            id: String(row.id),
            movementType: String(row.movement_type),
            source: 'plastic',
            label: stock?.stock_code ?? String(row.plastic_stock_id),
            qty: asNumber(row.boxes as number | string),
            unit: String(row.unit),
            notes: String(row.notes ?? ''),
            employeeName: employee?.full_name ?? '',
            createdAt: String(row.created_at),
          });
        }
      }

      recentMovements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        kind,
        name: central.name,
        description: AREA_COPY[kind],
        lots,
        plastic,
        recentMovements: recentMovements.slice(0, 30),
      };
    },
  };
}
