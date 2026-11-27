import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { portalPublicBase } from '../../shared/portal-public-url';
import { requirePermission } from '../../plugins/permissions';
import { createInventoryAlertsService } from './alerts-service';
import { createInventoryCentralQrsService } from './central-qrs-service';
import { createInventoryLabRecipesService } from './lab-recipes-service';
import { createInventoryLotsService } from './lots-service';
import { createInventoryPlasticService } from './plastic-service';
import { createInventoryPrepService } from './prep-service';
import { createInventoryLogsService } from './logs-service';
import { createInventoryReportsService } from './reports-service';
import { createInventoryService } from './service';
import { createInventoryStorageService } from './storage-service';
import { createInventorySopsService } from './sops-service';

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

const categoryCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  deductionMode: Type.Union([Type.Literal('measured'), Type.Literal('box')]),
  defaultAlertMode: Type.Optional(alertMode),
  defaultReorderQty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  defaultVelocityDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  defaultExpiryLeadDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
});

const categoryPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  defaultAlertMode: Type.Optional(alertMode),
  defaultReorderQty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  defaultVelocityDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  defaultExpiryLeadDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
});

const catalogCreateBody = Type.Object({
  categoryId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  brandName: Type.Optional(Type.String({ maxLength: 128 })),
  catalogNumber: Type.Optional(Type.String({ maxLength: 128 })),
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
  brandName: Type.Optional(Type.String({ maxLength: 128 })),
  catalogNumber: Type.Optional(Type.String({ maxLength: 128 })),
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
  centralQrId: Type.String({ minLength: 1 }),
  supplierName: Type.Optional(Type.String()),
  supplierType: Type.Optional(Type.Union([Type.Literal('external'), Type.Literal('internal')])),
  purchaseDate: Type.String({ minLength: 1 }),
  qty: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  openedOn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
  /** Required when issuing from a central usage area. */
  lotId: Type.Optional(Type.String({ minLength: 1 })),
  notes: Type.Optional(Type.String()),
});

const publicTransferBody = Type.Object({
  employeeId: Type.String({ minLength: 1 }),
  lotId: Type.String({ minLength: 1 }),
  notes: Type.Optional(Type.String()),
});

const lotTransferBody = Type.Object({
  notes: Type.Optional(Type.String()),
  employeeId: Type.Optional(Type.String({ minLength: 1 })),
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
  categoryId: Type.Optional(Type.String({ minLength: 1 })),
});

const stationPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  notes: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
});

const plasticReceiveBody = Type.Object({
  catalogItemId: Type.String({ minLength: 1 }),
  locationId: Type.String({ minLength: 1 }),
  centralQrId: Type.String({ minLength: 1 }),
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

const publicPlasticIssueBatchBody = Type.Object({
  employeeId: Type.String({ minLength: 1 }),
  lines: Type.Array(
    Type.Object({
      plasticStockId: Type.String({ minLength: 1 }),
      boxes: Type.Integer({ minimum: 1 }),
      notes: Type.Optional(Type.String()),
    }),
    { minItems: 1, maxItems: 12 },
  ),
});

export async function registerInventoryRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => createInventoryService(app.supabase!);
  const lots = () => createInventoryLotsService(app.supabase!);
  const prep = () => createInventoryPrepService(app.supabase!);
  const plastic = () => createInventoryPlasticService(app.supabase!);
  const centralQrs = () => createInventoryCentralQrsService(app.supabase!);
  const lab = () => createInventoryLabRecipesService(app.supabase!);
  const storage = () => createInventoryStorageService(app.supabase!);
  const sops = () => createInventorySopsService(app.supabase!);
  const alerts = () => createInventoryAlertsService(app.supabase!);
  const reports = () => createInventoryReportsService(app.supabase!);
  const logs = () => createInventoryLogsService(app.supabase!);

  const labManagePerms = [
    requirePermission(
      PERMISSIONS.INVENTORY_LAB_MANAGE,
      PERMISSIONS.INVENTORY_LOTS_MANAGE,
      PERMISSIONS.INVENTORY_PREP_MANAGE,
    ),
  ];

  const sopManagePerms = [
    requirePermission(
      PERMISSIONS.INVENTORY_SOPS_MANAGE,
      PERMISSIONS.INVENTORY_LAB_MANAGE,
      PERMISSIONS.INVENTORY_LOTS_MANAGE,
    ),
  ];

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

  app.post(
    '/api/v1/inventory/categories',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_CATEGORIES_MANAGE)],
      schema: { body: categoryCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await svc().createCategory(
          request.user!,
          request.body as {
            name: string;
            deductionMode: 'measured' | 'box';
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
            name?: string;
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
            brandName?: string;
            catalogNumber?: string;
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
            brandName?: string;
            catalogNumber?: string;
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
            centralQrId: string;
            supplierName?: string;
            supplierType?: 'external' | 'internal';
            purchaseDate: string;
            qty: number;
            unit?: string;
            totalCost?: number;
            expiryDate?: string | null;
            openedOn?: string | null;
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

  app.post(
    '/api/v1/inventory/lots/:id/transfer-inside-lab',
    {
      preHandler: [requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE)],
      schema: { body: lotTransferBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await lots().transferLotToInsideLab(
          request.user!,
          id,
          request.body as { notes?: string; employeeId?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/storage/:kind',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_LOTS_MANAGE, PERMISSIONS.INVENTORY_PLASTIC_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { kind } = request.params as { kind: string };
      if (kind !== 'stock_room' && kind !== 'inside_lab' && kind !== 'stationery') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Unknown storage area.', 400);
      }
      return ok(await storage().getArea(request.user!, kind));
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

  app.get('/api/v1/inventory/lab/activities', { preHandler: labManagePerms }, async (request) => {
    requireDb(app, request);
    return ok(await lab().listActivities(request.user!));
  });

  const usageModeSchema = Type.Union([
    Type.Literal('method'),
    Type.Literal('recipe'),
    Type.Literal('gel'),
  ]);

  app.post(
    '/api/v1/inventory/lab/activities',
    {
      preHandler: labManagePerms,
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          description: Type.Optional(Type.String()),
          sortOrder: Type.Optional(Type.Integer()),
          usageMode: Type.Optional(usageModeSchema),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await lab().createActivity(
          request.user!,
          request.body as {
            name: string;
            description?: string;
            sortOrder?: number;
            usageMode?: 'method' | 'recipe' | 'gel';
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/inventory/lab/activities/:id',
    {
      preHandler: labManagePerms,
      schema: {
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          description: Type.Optional(Type.String()),
          sortOrder: Type.Optional(Type.Integer()),
          status: Type.Optional(status),
          usageMode: Type.Optional(usageModeSchema),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await lab().updateActivity(
          request.user!,
          id,
          request.body as {
            name?: string;
            description?: string;
            sortOrder?: number;
            status?: 'active' | 'inactive';
            usageMode?: 'method' | 'recipe' | 'gel';
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/inventory/lab/activities/:activityId/gel',
    { preHandler: labManagePerms },
    async (request) => {
      requireDb(app, request);
      const { activityId } = request.params as { activityId: string };
      return ok(await lab().getManagedGelChart(request.user!, activityId));
    },
  );

  app.put(
    '/api/v1/inventory/lab/activities/:activityId/gel/components',
    {
      preHandler: labManagePerms,
      schema: {
        body: Type.Object({
          components: Type.Array(
            Type.Object({
              componentKey: Type.Union([
                Type.Literal('agarose'),
                Type.Literal('buffer'),
                Type.Literal('stain'),
              ]),
              name: Type.Optional(Type.String()),
              catalogItemId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            { minItems: 1, maxItems: 3 },
          ),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      const { activityId } = request.params as { activityId: string };
      return ok(
        await lab().updateGelComponentLinks(
          request.user!,
          activityId,
          request.body as {
            components: Array<{
              componentKey: 'agarose' | 'buffer' | 'stain';
              name?: string;
              catalogItemId?: string | null;
            }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get('/api/v1/inventory/lab/recipes', { preHandler: labManagePerms }, async (request) => {
    requireDb(app, request);
    const query = request.query as { activityId?: string };
    return ok(await lab().listRecipes(request.user!, query.activityId));
  });

  app.get('/api/v1/inventory/lab/recipes/:id', { preHandler: labManagePerms }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await lab().getRecipe(request.user!, id));
  });

  const recipeComponentBody = Type.Object({
    id: Type.Optional(Type.String()),
    name: Type.String({ minLength: 1 }),
    quantityValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    quantityUnit: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    sortOrder: Type.Optional(Type.Integer()),
    catalogItemId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });

  app.post(
    '/api/v1/inventory/lab/recipes',
    {
      preHandler: labManagePerms,
      schema: {
        body: Type.Object({
          activityId: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          finalVolumeValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          finalVolumeUnit: Type.Optional(Type.String()),
          notes: Type.Optional(Type.String()),
          sortOrder: Type.Optional(Type.Integer()),
          createsOutputLot: Type.Optional(Type.Boolean()),
          outputCatalogItemId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          sopFileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          components: Type.Optional(Type.Array(recipeComponentBody, { maxItems: 40 })),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await lab().createRecipe(
          request.user!,
          request.body as {
            activityId: string;
            name: string;
            finalVolumeValue?: number | null;
            finalVolumeUnit?: string;
            notes?: string;
            sortOrder?: number;
            createsOutputLot?: boolean;
            outputCatalogItemId?: string | null;
            sopFileId?: string | null;
            components?: Array<{
              name: string;
              quantityValue?: number | null;
              quantityUnit?: string;
              notes?: string;
              sortOrder?: number;
              catalogItemId?: string | null;
            }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/inventory/lab/recipes/:id',
    {
      preHandler: labManagePerms,
      schema: {
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          finalVolumeValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          finalVolumeUnit: Type.Optional(Type.String()),
          notes: Type.Optional(Type.String()),
          sortOrder: Type.Optional(Type.Integer()),
          status: Type.Optional(status),
          createsOutputLot: Type.Optional(Type.Boolean()),
          outputCatalogItemId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          sopFileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          components: Type.Optional(Type.Array(recipeComponentBody, { maxItems: 40 })),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await lab().updateRecipe(
          request.user!,
          id,
          request.body as {
            name?: string;
            finalVolumeValue?: number | null;
            finalVolumeUnit?: string;
            notes?: string;
            sortOrder?: number;
            status?: 'active' | 'inactive';
            createsOutputLot?: boolean;
            outputCatalogItemId?: string | null;
            sopFileId?: string | null;
            components?: Array<{
              id?: string;
              name: string;
              quantityValue?: number | null;
              quantityUnit?: string;
              notes?: string;
              sortOrder?: number;
              catalogItemId?: string | null;
            }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.delete('/api/v1/inventory/lab/recipes/:id', { preHandler: labManagePerms }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await lab().deleteRecipe(request.user!, id, metaOf(request)));
  });

  app.get('/api/v1/inventory/sops/folders', { preHandler: sopManagePerms }, async (request) => {
    requireDb(app, request);
    const query = request.query as { parentId?: string };
    const parentId = query.parentId === undefined ? undefined : query.parentId || null;
    return ok(await sops().listFolders(request.user!, parentId));
  });

  app.post(
    '/api/v1/inventory/sops/folders',
    {
      preHandler: sopManagePerms,
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          sortOrder: Type.Optional(Type.Integer()),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await sops().createFolder(
          request.user!,
          request.body as { name: string; parentId?: string | null; sortOrder?: number },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/inventory/sops/folders/:id',
    {
      preHandler: sopManagePerms,
      schema: {
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          sortOrder: Type.Optional(Type.Integer()),
          status: Type.Optional(status),
          parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await sops().updateFolder(
          request.user!,
          id,
          request.body as {
            name?: string;
            sortOrder?: number;
            status?: 'active' | 'inactive';
            parentId?: string | null;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.delete('/api/v1/inventory/sops/folders/:id', { preHandler: sopManagePerms }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await sops().deleteFolder(request.user!, id, metaOf(request)));
  });

  app.get('/api/v1/inventory/sops/files', { preHandler: sopManagePerms }, async (request) => {
    requireDb(app, request);
    const query = request.query as { folderId?: string };
    if (query.folderId) {
      return ok(await sops().listFiles(request.user!, query.folderId));
    }
    return ok(await sops().listAllFiles(request.user!));
  });

  app.post(
    '/api/v1/inventory/sops/folders/:id/files',
    {
      preHandler: sopManagePerms,
      bodyLimit: 20_000_000,
      schema: {
        body: Type.Object({
          title: Type.Optional(Type.String()),
          fileName: Type.String({ minLength: 1 }),
          contentBase64: Type.String({ minLength: 8 }),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await sops().uploadFile(
          request.user!,
          id,
          request.body as { title?: string; fileName: string; contentBase64: string },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/inventory/sops/files/:id',
    {
      preHandler: sopManagePerms,
      schema: {
        body: Type.Object({
          title: Type.Optional(Type.String({ minLength: 1 })),
          folderId: Type.Optional(Type.String({ minLength: 1 })),
        }),
      },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await sops().updateFile(
          request.user!,
          id,
          request.body as { title?: string; folderId?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.delete('/api/v1/inventory/sops/files/:id', { preHandler: sopManagePerms }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await sops().deleteFile(request.user!, id, metaOf(request)));
  });

  app.get('/api/v1/inventory/sops/files/:id/pdf', { preHandler: sopManagePerms }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await sops().getFilePdf(request.user!, id));
  });

  app.get(
    '/api/v1/inventory/central-qrs',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      return ok(await centralQrs().list(request.user!));
    },
  );

  app.get(
    '/api/v1/inventory/central-qrs/:id/print',
    {
      preHandler: [
        requirePermission(PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE),
      ],
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await centralQrs().getPrint(request.user!, id, portalPublicBase()));
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
          request.body as { locationId: string; name: string; notes?: string; categoryId?: string },
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
            centralQrId: string;
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

  app.get(
    '/api/v1/inventory/logs',
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
      return ok(await logs().getLogs(request.user!, query));
    },
  );

  app.get(
    '/api/v1/inventory/logs/export',
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
      return ok(await logs().exportExcel(request.user!, query));
    },
  );

  // Public kiosk — no JWT. Prefer central usage areas; legacy station / bottle tokens still resolve.
  app.get('/api/v1/inventory/public/scan/:token', async (request) => {
    requireDbOnly(app);
    const { token } = request.params as { token: string };
    const centralCard = await centralQrs().getPublicCard(token);
    if (centralCard) {
      return ok(centralCard);
    }
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
          request.body as { employeeId: string; qty: number; lotId?: string; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/inventory/public/scan/:token/transfer-inside-lab',
    { schema: { body: publicTransferBody } },
    async (request) => {
      requireDbOnly(app);
      const { token } = request.params as { token: string };
      return ok(
        await lots().publicTransferToInsideLab(
          token,
          request.body as { employeeId: string; lotId: string; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.get('/api/v1/inventory/public/lab/activities/:activityId/recipes', async (request) => {
    requireDbOnly(app);
    const { activityId } = request.params as { activityId: string };
    return ok(await lab().listPublicRecipes(activityId));
  });

  app.get('/api/v1/inventory/public/lab/activities/:activityId/gel', async (request) => {
    requireDbOnly(app);
    const { activityId } = request.params as { activityId: string };
    return ok(await lab().getGelChart(activityId));
  });

  app.get('/api/v1/inventory/public/lab/recipes/:id', async (request) => {
    requireDbOnly(app);
    const { id } = request.params as { id: string };
    return ok(await lab().getPublicRecipe(id));
  });

  app.get('/api/v1/inventory/public/scan/:token/lab-recipes/:recipeId/sop', async (request) => {
    requireDbOnly(app);
    const { token, recipeId } = request.params as { token: string; recipeId: string };
    return ok(await sops().getPublicRecipeSop(token, recipeId));
  });

  app.post(
    '/api/v1/inventory/public/scan/:token/lab-usage',
    {
      schema: {
        body: Type.Object({
          employeeId: Type.String({ minLength: 1 }),
          activityId: Type.String({ minLength: 1 }),
          recipeId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
          notes: Type.Optional(Type.String()),
          outputQty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          quantityMultiplier: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          gelPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          gelVolumeMl: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          components: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ minLength: 1 }),
                quantityValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                quantityUnit: Type.Optional(Type.String()),
                notes: Type.Optional(Type.String()),
                catalogItemId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              }),
              { maxItems: 40 },
            ),
          ),
        }),
      },
    },
    async (request) => {
      requireDbOnly(app);
      const { token } = request.params as { token: string };
      return ok(
        await lab().submitPublicUsage(
          token,
          request.body as {
            employeeId: string;
            activityId: string;
            recipeId?: string | null;
            notes?: string;
            outputQty?: number | null;
            quantityMultiplier?: number | null;
            gelPercent?: number | null;
            gelVolumeMl?: number | null;
            components?: Array<{
              name: string;
              quantityValue?: number | null;
              quantityUnit?: string;
              notes?: string;
              catalogItemId?: string | null;
            }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/inventory/public/scan/:token/plastic-issue-batch',
    { schema: { body: publicPlasticIssueBatchBody } },
    async (request) => {
      requireDbOnly(app);
      const { token } = request.params as { token: string };
      return ok(
        await plastic().publicIssuePlasticBatch(
          token,
          request.body as {
            employeeId: string;
            lines: { plasticStockId: string; boxes: number; notes?: string }[];
          },
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
