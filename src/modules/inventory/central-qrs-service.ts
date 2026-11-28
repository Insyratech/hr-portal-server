import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { canManageLots, canManagePlastic } from './access';
import { createInventoryLabRecipesService } from './lab-recipes-service';
import type {
  InventoryCentralQr,
  InventoryCentralQrKind,
  InventoryCentralQrPrint,
  InventoryEmployeeOption,
  InventoryPublicCentralCard,
  InventoryPublicCentralLabCard,
  InventoryPublicCentralLotItem,
  InventoryPublicLabCatalogItem,
  InventoryPublicStationItem,
  InventoryPublicStorageGuideCard,
  InventoryStorageGuideLocationRow,
  InventoryStorageGuideLookup,
} from './types';

type CentralQrRow = {
  id: string;
  kind: InventoryCentralQrKind;
  name: string;
  qr_token: string;
  status: 'active' | 'inactive';
  notes: string;
  created_at: string;
  updated_at: string;
};

const CENTRAL_SELECT = 'id, kind, name, qr_token, status, notes, created_at, updated_at';

const LOT_LIST_SELECT =
  'id, lot_code, remaining_qty, unit, qty_chips, status, expiry_date, inventory_catalog_items(id, name, catalog_number, inventory_categories(name))';

const PLASTIC_LIST_SELECT =
  'id, stock_code, manufacturer, size_label, boxes_on_hand, unit, qty_chips, status, inventory_catalog_items(id, name)';

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

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

function mapCentral(row: CentralQrRow): InventoryCentralQr {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qrToken: row.qr_token,
    status: row.status,
    notes: row.notes,
    scanPath: `/scan/${row.qr_token}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadActiveEmployees(supabase: SupabaseClient): Promise<InventoryEmployeeOption[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, employee_code, full_name, email')
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('full_name');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee list.', 500);
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
}

function canViewCentral(actor: RequestUser): boolean {
  return canManageLots(actor) || canManagePlastic(actor);
}

export function createInventoryCentralQrsService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser): Promise<InventoryCentralQr[]> {
      if (!canViewCentral(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view usage areas.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_central_qrs')
        .select(CENTRAL_SELECT)
        .order('kind');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list usage areas.', 500);
      }
      return ((data ?? []) as CentralQrRow[]).map(mapCentral);
    },

    async get(actor: RequestUser, id: string): Promise<InventoryCentralQr> {
      if (!canViewCentral(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view usage areas.', 403);
      }
      const { data, error } = await supabase
        .from('inventory_central_qrs')
        .select(CENTRAL_SELECT)
        .eq('id', id)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Usage area not found.', 404);
      }
      return mapCentral(data as CentralQrRow);
    },

    async getByKind(kind: InventoryCentralQrKind): Promise<InventoryCentralQr> {
      const { data, error } = await supabase
        .from('inventory_central_qrs')
        .select(CENTRAL_SELECT)
        .eq('kind', kind)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, `Usage area "${kind}" is not configured.`, 404);
      }
      return mapCentral(data as CentralQrRow);
    },

    async getByToken(token: string): Promise<InventoryCentralQr | null> {
      const qrToken = token.trim();
      if (!qrToken) return null;
      const { data, error } = await supabase
        .from('inventory_central_qrs')
        .select(CENTRAL_SELECT)
        .eq('qr_token', qrToken)
        .maybeSingle();
      if (error || !data) return null;
      return mapCentral(data as CentralQrRow);
    },

    async getPrint(actor: RequestUser, id: string, siteUrl: string): Promise<InventoryCentralQrPrint> {
      const central = await this.get(actor, id);
      const base = siteUrl.replace(/\/$/, '');
      return {
        central,
        scanUrl: `${base}${central.scanPath}`,
        labelTitle: central.name,
      };
    },

    async requireActiveId(centralQrId: string): Promise<InventoryCentralQr> {
      const id = centralQrId.trim();
      if (!id) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select a room destination QR.', 400);
      }
      const { data, error } = await supabase
        .from('inventory_central_qrs')
        .select(CENTRAL_SELECT)
        .eq('id', id)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown room destination QR.', 400);
      }
      const central = mapCentral(data as CentralQrRow);
      if (central.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'That usage area is inactive.', 400);
      }
      if (central.kind === 'storage_guide') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '“Where to store” is a lookup QR only — choose Stock room, Stationery, or Inside lab for receive.',
          400,
        );
      }
      return central;
    },

    async assertStorageGuideToken(token: string): Promise<InventoryCentralQr> {
      const central = await this.getByToken(token);
      if (!central) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Unknown usage area.', 404);
      }
      if (central.status !== 'active' || central.kind !== 'storage_guide') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Catalog location lookup is only available on the Where to store QR.',
          400,
        );
      }
      return central;
    },

    async listStorageGuideCatalog(token: string): Promise<InventoryPublicLabCatalogItem[]> {
      await this.assertStorageGuideToken(token);
      const { data, error } = await supabase
        .from('inventory_catalog_items')
        .select('id, name, brand_name, catalog_number, unit, status, inventory_categories(name)')
        .eq('status', 'active')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list catalog items.', 500);
      }
      return ((data ?? []) as Array<{
        id: string;
        name: string;
        brand_name: string | null;
        catalog_number: string | null;
        unit: string;
        inventory_categories?: { name: string } | { name: string }[] | null;
      }>).map((row) => {
        const category = one(row.inventory_categories);
        return {
          id: row.id,
          name: row.name,
          brandName: (row.brand_name ?? '').trim(),
          catalogNumber: (row.catalog_number ?? '').trim(),
          categoryName: category?.name ?? '',
          unit: row.unit,
        };
      });
    },

    async lookupStorageGuideLocations(
      token: string,
      catalogItemId: string,
    ): Promise<InventoryStorageGuideLookup> {
      await this.assertStorageGuideToken(token);
      const itemId = catalogItemId.trim();
      if (!itemId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select a catalog item.', 400);
      }

      const { data: catalog, error: catalogError } = await supabase
        .from('inventory_catalog_items')
        .select('id, name, catalog_number, unit, status, inventory_categories(name)')
        .eq('id', itemId)
        .single();
      if (catalogError || !catalog || catalog.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown or inactive catalog item.', 400);
      }
      const category = one(
        (
          catalog as {
            inventory_categories?: { name: string } | { name: string }[] | null;
          }
        ).inventory_categories,
      );

      const locationMap = new Map<string, InventoryStorageGuideLocationRow>();

      const mergeRow = (row: InventoryStorageGuideLocationRow) => {
        const key = `${row.locationId}|${row.unit}|${row.stockKind}`;
        const existing = locationMap.get(key);
        if (!existing) {
          locationMap.set(key, { ...row });
          return;
        }
        existing.remainingQty =
          Math.round((existing.remainingQty + row.remainingQty) * 10000) / 10000;
        existing.containerCount += row.containerCount;
      };

      const [{ data: lotRows, error: lotError }, { data: plasticRows, error: plasticError }] =
        await Promise.all([
          supabase
            .from('inventory_lots')
            .select(
              'remaining_qty, unit, inventory_locations(id, code, name, location_type), inventory_central_qrs(name)',
            )
            .eq('catalog_item_id', itemId)
            .eq('status', 'active')
            .gt('remaining_qty', 0),
          supabase
            .from('inventory_plastic_stock')
            .select(
              'boxes_on_hand, unit, inventory_locations(id, code, name, location_type), inventory_central_qrs(name)',
            )
            .eq('catalog_item_id', itemId)
            .eq('status', 'active')
            .gt('boxes_on_hand', 0),
        ]);
      if (lotError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lot locations.', 500);
      }
      if (plasticError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load plastic locations.', 500);
      }

      for (const row of (lotRows ?? []) as Array<{
        remaining_qty: number | string;
        unit: string;
        inventory_locations?:
          | { id: string; code: string; name: string; location_type: string }
          | { id: string; code: string; name: string; location_type: string }[]
          | null;
        inventory_central_qrs?: { name: string } | { name: string }[] | null;
      }>) {
        const location = one(row.inventory_locations);
        if (!location) continue;
        const area = one(row.inventory_central_qrs);
        mergeRow({
          locationId: location.id,
          locationCode: location.code,
          locationName: location.name,
          locationType: location.location_type,
          usageAreaName: area?.name ?? '',
          remainingQty: asNumber(row.remaining_qty),
          unit: row.unit,
          stockKind: 'measured',
          containerCount: 1,
        });
      }

      for (const row of (plasticRows ?? []) as Array<{
        boxes_on_hand: number | string;
        unit: string;
        inventory_locations?:
          | { id: string; code: string; name: string; location_type: string }
          | { id: string; code: string; name: string; location_type: string }[]
          | null;
        inventory_central_qrs?: { name: string } | { name: string }[] | null;
      }>) {
        const location = one(row.inventory_locations);
        if (!location) continue;
        const area = one(row.inventory_central_qrs);
        mergeRow({
          locationId: location.id,
          locationCode: location.code,
          locationName: location.name,
          locationType: location.location_type,
          usageAreaName: area?.name ?? '',
          remainingQty: Math.trunc(asNumber(row.boxes_on_hand)),
          unit: row.unit || 'box',
          stockKind: 'box',
          containerCount: 1,
        });
      }

      const locations = [...locationMap.values()].sort((a, b) => {
        const byName = a.locationName.localeCompare(b.locationName);
        if (byName !== 0) return byName;
        return a.stockKind.localeCompare(b.stockKind);
      });

      return {
        catalogItemId: (catalog as { id: string }).id,
        catalogItemName: (catalog as { name: string }).name,
        catalogNumber: ((catalog as { catalog_number?: string | null }).catalog_number ?? '').trim(),
        categoryName: category?.name ?? '',
        locations,
      };
    },

    async getPublicCard(
      token: string,
    ): Promise<
      | InventoryPublicCentralCard
      | InventoryPublicCentralLabCard
      | InventoryPublicStorageGuideCard
      | null
    > {
      const central = await this.getByToken(token);
      if (!central) return null;
      if (central.status !== 'active') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This usage area is inactive.', 400);
      }

      if (central.kind === 'inside_lab') {
        const lab = createInventoryLabRecipesService(supabase);
        const activities = await lab.listPublicActivities();
        return {
          kind: 'central_lab',
          name: central.name,
          centralKind: 'inside_lab',
          message: 'Choose your work type and recipe, adjust components if needed, then submit.',
          activities,
          employees: await loadActiveEmployees(supabase),
        };
      }

      if (central.kind === 'storage_guide') {
        return {
          kind: 'storage_guide',
          name: central.name,
          centralKind: 'storage_guide',
          message:
            'Search by name or catalogue number to see every shelf location where this material already has stock.',
        };
      }

      const employees = await loadActiveEmployees(supabase);
      const lots: InventoryPublicCentralLotItem[] = [];
      const plasticItems: InventoryPublicStationItem[] = [];

      if (central.kind === 'stock_room') {
        const { data: lotRows, error: lotError } = await supabase
          .from('inventory_lots')
          .select(LOT_LIST_SELECT)
          .eq('central_qr_id', central.id)
          .eq('status', 'active')
          .gt('remaining_qty', 0)
          .order('created_at', { ascending: false });
        if (lotError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lots for stock room.', 500);
        }
        for (const row of (lotRows ?? []) as Array<{
          id: string;
          lot_code: string;
          remaining_qty: number | string;
          unit: string;
          qty_chips: unknown;
          expiry_date: string | null;
          inventory_catalog_items?:
            | {
                name: string;
                catalog_number?: string | null;
                inventory_categories?: { name: string } | { name: string }[] | null;
              }
            | {
                name: string;
                catalog_number?: string | null;
                inventory_categories?: { name: string } | { name: string }[] | null;
              }[]
            | null;
        }>) {
          const catalog = one(row.inventory_catalog_items);
          const category = one(catalog?.inventory_categories ?? null);
          lots.push({
            id: row.id,
            lotCode: row.lot_code,
            itemName: catalog?.name ?? '',
            categoryName: category?.name ?? '',
            catalogNumber: (catalog?.catalog_number ?? '').trim(),
            remainingQty: asNumber(row.remaining_qty),
            unit: row.unit,
            qtyChips: parseQtyChips(row.qty_chips),
            expiryDate: row.expiry_date,
          });
        }
      }

      const { data: plasticRows, error: plasticError } = await supabase
        .from('inventory_plastic_stock')
        .select(PLASTIC_LIST_SELECT)
        .eq('central_qr_id', central.id)
        .eq('status', 'active')
        .gt('boxes_on_hand', 0)
        .order('created_at', { ascending: false });
      if (plasticError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load box stock for usage area.', 500);
      }
      for (const row of (plasticRows ?? []) as Array<{
        id: string;
        stock_code: string;
        manufacturer: string;
        size_label: string;
        boxes_on_hand: number | string;
        unit: string;
        qty_chips: unknown;
        inventory_catalog_items?: { name: string } | { name: string }[] | null;
      }>) {
        const catalog = one(row.inventory_catalog_items);
        plasticItems.push({
          id: row.id,
          stockCode: row.stock_code,
          itemName: catalog?.name ?? '',
          manufacturer: row.manufacturer,
          sizeLabel: row.size_label,
          boxesOnHand: Math.trunc(asNumber(row.boxes_on_hand)),
          unit: row.unit,
          qtyChips: parseQtyChips(row.qty_chips).map((n) => Math.trunc(n)).filter((n) => n > 0),
        });
      }

      return {
        kind: 'central',
        centralKind: central.kind,
        name: central.name,
        lots,
        plasticItems,
        employees,
      };
    },
  };
}
