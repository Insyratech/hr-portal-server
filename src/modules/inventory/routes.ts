import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { portalPublicBase } from '../../shared/portal-public-url';
import { requirePermission } from '../../plugins/permissions';
import { createInventoryAlertsService } from './alerts-service';
import { createInventoryLotsService } from './lots-service';
import { createInventoryPlasticService } from './plastic-service';
import { createInventoryPrepService } from './prep-service';
import { createInventoryReportsService } from './reports-service';
import { createInventoryService } from './service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const alertMode = Type.Union([
  Type.Literal('reorder'),
  Type.Literal('velocity'),
  Type.Literal('both'),
]);

const locationType = Type.String({ minLength: 2, maxLength: 40 });

const status = Type.Union([Type.Literal('active'), Type.Literal('inactive')]);

const locationCreateBody = Type.Object({
  code: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  locationType: Type.Optional(locationType),
});

const locationPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String()),
  locationType: Type.Optional(locationType),
  status: Type.Optional(status),
});

const categoryPatchBody = Type.Object({
  defaultAlertMode: Type.Optional(alertMode),
  defaultReorderQty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  defaultVelocityDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  defaultExpiryLeadDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
});

const catalogCreateBody = Type.Object({
  categoryId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  unit: Type.String({ minLength: 1 }),
  defaultQtyChips: Type.Optional(Type.Array(Type.Number(), { maxItems: 15 })),
  alertMode: Type.Optional(alertMode),
  reorderQty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  velocityDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 365 }), Type.Null()])),
  expiryLeadDays: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()])),
  notes: Type.Optional(Type.String()),
});

const catalogPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  unit: Type.Optional(Type.String({ minLength: 1 })),
  defaultQtyChips: Type.Optional(Type.Array(Type.Number(), { maxItems: 15 })),
  alertMode: Type.Optional(alertMode),
  reorderQty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  velocityDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 365 }), Type.Null()])),
  expiryLeadDays: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()])),
  notes: Type.Optional(Type.String()),
  status: Type.Optional(status),
});

function requireDbOnly(app: FastifyInstance) {
  if (!app.supabase) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const authorizationBody = Type.Object({
  employeeId: Type.String({ minLength: 1 }),
  canUsage: Type.Boolean(),
  canReceipt: Type.Boolean(),
  canPrep: Type.Boolean(),
  notes: Type.Optional(Type.String()),
});

const lotReceiveBody = Type.Object({
  catalogItemId: Type.String({ minLength: 1 }),
  locationId: Type.String({ minLength: 1 }),
  supplierName: Type.Optional(Type.String()),
  supplierType: Type.Optional(Type.Union([Type.Literal('external'), Type.Literal('internal')])),
  purchaseDate: Type.String({ minLength: 1 }),
  qty: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  qtyChips: Type.Optional(Type.Array(Type.Number(), { maxItems: 15 })),
  notes: Type.Optional(Type.String()),
});

const lotAdjustBody = Type.Object({
  remainingQty: Type.Number({ minimum: 0 }),
  notes: Type.String({ minLength: 3 }),
});

const publicIssueBody = Type.Object({
  employeeId: Type.String({ minLength: 1 }),
  qty: Type.Number({ exclusiveMinimum: 0 }),
  notes: Type.Optional(Type.String()),
});

const prepCreateBody = Type.Object({
  catalogItemId: Type.String({ minLength: 1 }),
  locationId: Type.String({ minLength: 1 }),
  targetQty: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  qtyChips: Type.Optional(Type.Array(Type.Number(), { maxItems: 15 })),
  notes: Type.Optional(Type.String()),
});

const prepInputBody = Type.Object({
  sourceLotId: Type.String({ minLength: 1 }),
  qty: Type.Number({ exclusiveMinimum: 0 }),
  notes: Type.Optional(Type.String()),
});

const prepCompleteBody = Type.Object({
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.String()),
});

const stationCreateBody = Type.Object({
  locationId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  notes: Type.Optional(Type.String()),
});

const stationPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  notes: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
});

const plasticReceiveBody = Type.Object({
  catalogItemId: Type.String({ minLength: 1 }),
  locationId: Type.String({ minLength: 1 }),
  manufacturer: Type.Optional(Type.String()),
  sizeLabel: Type.String({ minLength: 1 }),
  attributes: Type.Optional(Type.Record(Type.String(), Type.String())),
  boxes: Type.Integer({ minimum: 1 }),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
  supplierName: Type.Optional(Type.String()),
  supplierType: Type.Optional(Type.Union([Type.Literal('external'), Type.Literal('internal')])),
  purchaseDate: Type.String({ minLength: 1 }),
  qtyChips: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 15 })),
  notes: Type.Optional(Type.String()),
});

const plasticAdjustBody = Type.Object({
  boxesOnHand: Type.Integer({ minimum: 0 }),
  notes: Type.String({ minLength: 3 }),
});

const publicPlasticIssueBody = Type.Object({
  employeeId: Type.String({ minLength: 1 }),
  plasticStockId: Type.String({ minLength: 1 }),
  boxes: Type.Integer({ minimum: 1 }),
  notes: Type.Optional(Type.String()),
});

export async function registerInventoryRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => createInventoryService(app.supabase!);
  const lots = () => createInventoryLotsService(app.supabase!);
  const prep = () => createInventoryPrepService(app.supabase!);
  const plastic = () => createInventoryPlasticService(app.supabase!);
  const alerts = () => createInventoryAlertsService(app.supabase!);
  const reports = () => createInventoryReportsService(app.supabase!);

  app.get(
    '/api/v1/inventory/overview',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_OVERVIEW_VIEW)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().getOverview(request.user!));
    },
  );

  app.get(
    '/api/v1/inventory/admin-overview',
    { preHandler: [requirePermission(PERMISSIONS.SYSTEM_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().getAdminOverview(request.user!));
    },
  );

  app.get(
    '/api/v1/inventory/admin-dashboard',
    { preHandler: [requirePermission(PERMISSIONS.SYSTEM_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { period?: string; from?: string; to?: string };
      return ok(await reports().getAdminDashboard(request.user!, query));
    },
  );

  app.get(
    '/api/v1/inventory/locations',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOCATIONS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listLocations(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/locations',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOCATIONS_MANAGE)],
      schema: { body: locationCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await svc().createLocation(
          request.user!,
          request.body as {
            code: string;
            name: string;
            description?: string;
            locationType?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/inventory/locations/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOCATIONS_MANAGE)],
      schema: { body: locationPatchBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await svc().updateLocation(
          request.user!,
          id,
          request.body as {
            name?: string;
            description?: string;
            locationType?: string;
            status?: 'active' | 'inactive';
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/categories',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.INVENTORY_CATEGORIES_MANAGE,
          PERMISSIONS.INVENTORY_CATALOG_MANAGE,
          PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
        ),
      ],
    },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listCategories(request.user!));
    },
  );

  app.patch(
    '/api/v1/inventory/categories/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_CATEGORIES_MANAGE)],
      schema: { body: categoryPatchBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await svc().updateCategoryDefaults(
          request.user!,
          id,
          request.body as {
            defaultAlertMode?: 'reorder' | 'velocity' | 'both';
            defaultReorderQty?: number | null;
            defaultVelocityDays?: number;
            defaultExpiryLeadDays?: number;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/catalog',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_CATALOG_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listCatalogItems(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/catalog',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_CATALOG_MANAGE)],
      schema: { body: catalogCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await svc().createCatalogItem(
          request.user!,
          request.body as {
            categoryId: string;
            name: string;
            unit: string;
            defaultQtyChips?: number[];
            alertMode?: 'reorder' | 'velocity' | 'both';
            reorderQty?: number | null;
            velocityDays?: number | null;
            expiryLeadDays?: number | null;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/inventory/catalog/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_CATALOG_MANAGE)],
      schema: { body: catalogPatchBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await svc().updateCatalogItem(
          request.user!,
          id,
          request.body as {
            name?: string;
            unit?: string;
            defaultQtyChips?: number[];
            alertMode?: 'reorder' | 'velocity' | 'both';
            reorderQty?: number | null;
            velocityDays?: number | null;
            expiryLeadDays?: number | null;
            notes?: string;
            status?: 'active' | 'inactive';
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/employee-options',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_AUTHORIZATIONS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listEmployeeOptions(request.user!));
    },
  );

  app.get(
    '/api/v1/inventory/authorizations',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_AUTHORIZATIONS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await svc().listAuthorizations(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/authorizations',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_AUTHORIZATIONS_MANAGE)],
      schema: { body: authorizationBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await svc().upsertAuthorization(
          request.user!,
          request.body as {
            employeeId: string;
            canUsage: boolean;
            canReceipt: boolean;
            canPrep: boolean;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.delete(
    '/api/v1/inventory/authorizations/:id',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_AUTHORIZATIONS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await svc().deleteAuthorization(request.user!, id, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/inventory/lots',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await lots().listLots(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/lots',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)],
      schema: { body: lotReceiveBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await lots().receiveLot(
          request.user!,
          request.body as {
            catalogItemId: string;
            locationId: string;
            supplierName?: string;
            supplierType?: 'external' | 'internal';
            purchaseDate: string;
            qty: number;
            unit?: string;
            totalCost?: number;
            expiryDate?: string | null;
            qtyChips?: number[];
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/lots/:id',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await lots().getLot(request.user!, id));
    },
  );

  app.get(
    '/api/v1/inventory/lots/:id/print',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await lots().getLotPrint(request.user!, id, portalPublicBase()));
    },
  );

  app.get(
    '/api/v1/inventory/lots/:id/expense',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await lots().getLotExpense(request.user!, id));
    },
  );

  app.get(
    '/api/v1/inventory/lots/:id/movements',
    { preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await lots().listMovements(request.user!, id));
    },
  );

  app.post(
    '/api/v1/inventory/lots/:id/adjust',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_ADJUST)],
      schema: { body: lotAdjustBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await lots().adjustLot(
          request.user!,
          id,
          request.body as { remainingQty: number; notes: string },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/prep-sessions',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      return ok(await prep().listPrepSessions(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/prep-sessions',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
      schema: { body: prepCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await prep().createPrepSession(
          request.user!,
          request.body as {
            catalogItemId: string;
            locationId: string;
            targetQty: number;
            unit?: string;
            qtyChips?: number[];
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/prep-sessions/:id',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await prep().getPrepSession(request.user!, id));
    },
  );

  app.post(
    '/api/v1/inventory/prep-sessions/:id/inputs',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
      schema: { body: prepInputBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await prep().addPrepInput(
          request.user!,
          id,
          request.body as { sourceLotId: string; qty: number; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/inventory/prep-sessions/:id/complete',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
      schema: { body: prepCompleteBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await prep().completePrepSession(
          request.user!,
          id,
          request.body as { expiryDate?: string | null; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/inventory/prep-sessions/:id/cancel',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await prep().cancelPrepSession(request.user!, id, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/inventory/stations',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      return ok(await plastic().listStations(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/stations',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
      schema: { body: stationCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await plastic().createStation(
          request.user!,
          request.body as { locationId: string; name: string; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/stations/:id',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await plastic().getStation(request.user!, id));
    },
  );

  app.get(
    '/api/v1/inventory/stations/:id/print',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await plastic().getStationPrint(request.user!, id, portalPublicBase()));
    },
  );

  app.patch(
    '/api/v1/inventory/stations/:id',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
      schema: { body: stationPatchBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await plastic().updateStation(
          request.user!,
          id,
          request.body as { name?: string; notes?: string; status?: 'active' | 'inactive' },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/plastic-stock',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      return ok(await plastic().listPlasticStock(request.user!));
    },
  );

  app.post(
    '/api/v1/inventory/plastic-stock',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
      schema: { body: plasticReceiveBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await plastic().receivePlasticStock(
          request.user!,
          request.body as {
            catalogItemId: string;
            locationId: string;
            manufacturer?: string;
            sizeLabel: string;
            attributes?: Record<string, string>;
            boxes: number;
            totalCost?: number;
            supplierName?: string;
            supplierType?: 'external' | 'internal';
            purchaseDate: string;
            qtyChips?: number[];
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/plastic-stock/:id',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await plastic().getPlasticStock(request.user!, id));
    },
  );

  app.get(
    '/api/v1/inventory/plastic-stock/:id/movements',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await plastic().listPlasticMovements(request.user!, id));
    },
  );

  app.post(
    '/api/v1/inventory/plastic-stock/:id/adjust',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_ADJUST, PERMISSIONS.INVENTORY_LOTS_ADJUST),
      ],
      schema: { body: plasticAdjustBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await plastic().adjustPlasticStock(
          request.user!,
          id,
          request.body as { boxesOnHand: number; notes: string },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/alerts',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.INVENTORY_ALERTS_VIEW,
          PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
          PERMISSIONS.INVENTORY_LOTS_MANAGE,
        ),
      ],
    },
    async (request) => {
      requireDb(app, request);
      return ok(await alerts().listActiveAlerts(request.user!));
    },
  );

  app.get(
    '/api/v1/inventory/alerts/log',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.INVENTORY_ALERTS_VIEW,
          PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
          PERMISSIONS.INVENTORY_LOTS_MANAGE,
        ),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { days?: string };
      const days = query.days ? Number(query.days) : 14;
      return ok(await alerts().listAlertLog(request.user!, Number.isFinite(days) ? days : 14));
    },
  );

  app.get(
    '/api/v1/inventory/reports',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.INVENTORY_REPORTS_VIEW,
          PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
          PERMISSIONS.INVENTORY_LOTS_MANAGE,
        ),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { period?: string; from?: string; to?: string };
      return ok(await reports().getReports(request.user!, query));
    },
  );

  app.get(
    '/api/v1/inventory/audit-export',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.INVENTORY_REPORTS_VIEW,
          PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
          PERMISSIONS.INVENTORY_LOTS_MANAGE,
        ),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { from?: string; to?: string };
      return ok(await reports().exportAuditCsv(request.user!, query));
    },
  );

  // Public kiosk — no JWT. Any active employee may submit usage after picking their name.
  // Token may be a measured lot or a plastic station.
  app.get('/api/v1/inventory/public/scan/:token', async (request) => {
    requireDbOnly(app);
    const { token } = request.params as { token: string };
    try {
      return ok(await lots().getPublicScanCard(token));
    } catch (lotError) {
      if (!(lotError instanceof AppError) || lotError.statusCode !== 404) {
        throw lotError;
      }
      const stationCard = await plastic().getPublicStationCard(token);
      if (!stationCard) {
        throw lotError;
      }
      return ok(stationCard);
    }
  });

  app.post(
    '/api/v1/inventory/public/scan/:token/issue',
    { schema: { body: publicIssueBody } },
    async (request) => {
      requireDbOnly(app);
      const { token } = request.params as { token: string };
      return ok(
        await lots().publicIssue(
          token,
          request.body as { employeeId: string; qty: number; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/inventory/public/scan/:token/plastic-issue',
    { schema: { body: publicPlasticIssueBody } },
    async (request) => {
      requireDbOnly(app);
      const { token } = request.params as { token: string };
      return ok(
        await plastic().publicIssuePlastic(
          token,
          request.body as {
            employeeId: string;
            plasticStockId: string;
            boxes: number;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );
}
