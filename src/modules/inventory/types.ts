export type InventoryAlertMode = 'reorder' | 'velocity' | 'both';
export type InventoryDeductionMode = 'measured' | 'box';
/** Preset or custom slug (e.g. stock_room, incubator). */
export type InventoryLocationType = string;
export type InventoryStatus = 'active' | 'inactive';

export type InventoryLocation = {
  id: string;
  code: string;
  name: string;
  description: string;
  locationType: InventoryLocationType;
  status: InventoryStatus;
  createdAt: string;
  updatedAt: string;
};

export type InventoryCategory = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  deductionMode: InventoryDeductionMode;
  defaultAlertMode: InventoryAlertMode;
  defaultReorderQty: number | null;
  defaultVelocityDays: number;
  defaultExpiryLeadDays: number;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
};

export type InventoryCatalogItem = {
  id: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  name: string;
  unit: string;
  defaultQtyChips: number[];
  alertMode: InventoryAlertMode;
  reorderQty: number | null;
  velocityDays: number | null;
  expiryLeadDays: number | null;
  notes: string;
  status: InventoryStatus;
  createdAt: string;
  updatedAt: string;
};

export type InventoryAuthorization = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeEmail: string;
  canUsage: boolean;
  canReceipt: boolean;
  canPrep: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type InventoryEmployeeOption = {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
};

export type InventoryOverview = {
  phase: number;
  title: string;
  message: string;
  modules: Record<string, string>;
  counts: {
    locations: number;
    categories: number;
    catalogItems: number;
    authorizations: number;
    activeLots: number;
    plasticStock?: number;
    stations?: number;
  };
};

export type InventoryAdminOverview = {
  phase: number;
  title: string;
  message: string;
  counts: {
    locations: number;
    categories: number;
    catalogItems: number;
    authorizations: number;
    activeLots?: number;
    plasticStock?: number;
  };
};

export type InventorySupplierType = 'external' | 'internal';
export type InventoryLotStatus = 'active' | 'depleted' | 'void';
export type InventoryLotOrigin = 'purchase' | 'prep';
export type InventoryMovementType = 'receive' | 'issue' | 'adjust';
export type InventoryPrepStatus = 'open' | 'completed' | 'cancelled';

export type InventoryLot = {
  id: string;
  lotCode: string;
  qrToken: string;
  catalogItemId: string;
  catalogItemName: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  supplierName: string;
  supplierType: InventorySupplierType;
  purchaseDate: string;
  receivedQty: number;
  remainingQty: number;
  unit: string;
  totalCost: number;
  componentCostTotal: number;
  origin: InventoryLotOrigin;
  countsTowardPurchaseExpense: boolean;
  prepSessionId: string | null;
  expiryDate: string | null;
  qtyChips: number[];
  status: InventoryLotStatus;
  notes: string;
  receivedBy: string | null;
  scanPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InventoryLotExpense = {
  lotId: string;
  lotCode: string;
  origin: InventoryLotOrigin;
  purchaseExpense: number;
  componentExpense: number;
  /** Amount that counts in spend reports (no double-count for lab-made reagents). */
  reportableExpense: number;
  note: string;
};

export type InventoryLotPrint = {
  lot: InventoryLot;
  scanUrl: string;
  labelTitle: string;
};

export type InventoryMovement = {
  id: string;
  lotId: string;
  movementType: InventoryMovementType;
  qty: number;
  qtyBefore: number;
  qtyAfter: number;
  unit: string;
  employeeId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
  notes: string;
  createdBy: string | null;
  prepSessionId: string | null;
  createdAt: string;
};

export type InventoryPublicScanCard = {
  kind?: 'lot';
  lotCode: string;
  itemName: string;
  categoryName: string;
  locationName: string;
  unit: string;
  remainingQty: number;
  qtyChips: number[];
  expiryDate: string | null;
  status: InventoryLotStatus;
  employees: InventoryEmployeeOption[];
};

export type InventoryPublicIssueResult = {
  lotCode: string;
  qtyIssued: number;
  remainingQty: number;
  unit: string;
  employeeName: string;
};

export type InventoryPrepInput = {
  id: string;
  prepSessionId: string;
  sourceLotId: string;
  sourceLotCode: string;
  sourceItemName: string;
  movementId: string;
  qty: number;
  unit: string;
  attributedCost: number;
  createdAt: string;
};

export type InventoryPrepSession = {
  id: string;
  catalogItemId: string;
  catalogItemName: string;
  locationId: string;
  locationName: string;
  targetQty: number;
  unit: string;
  qtyChips: number[];
  status: InventoryPrepStatus;
  notes: string;
  preparedBy: string | null;
  reagentLotId: string | null;
  reagentLotCode: string | null;
  componentCostTotal: number;
  inputs: InventoryPrepInput[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type InventoryPlasticStockStatus = 'active' | 'depleted' | 'void';
export type InventoryStationStatus = 'active' | 'inactive';
export type InventoryPlasticMovementType = 'receive' | 'issue' | 'adjust';

export type InventoryStation = {
  id: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  name: string;
  qrToken: string;
  status: InventoryStationStatus;
  notes: string;
  scanPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InventoryStationPrint = {
  station: InventoryStation;
  scanUrl: string;
  labelTitle: string;
};

export type InventoryPlasticStock = {
  id: string;
  stockCode: string;
  catalogItemId: string;
  catalogItemName: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  manufacturer: string;
  sizeLabel: string;
  attributes: Record<string, string>;
  boxesOnHand: number;
  boxesReceived: number;
  unit: string;
  totalCost: number;
  supplierName: string;
  supplierType: InventorySupplierType;
  purchaseDate: string;
  qtyChips: number[];
  status: InventoryPlasticStockStatus;
  notes: string;
  receivedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InventoryPlasticMovement = {
  id: string;
  plasticStockId: string;
  stationId: string | null;
  movementType: InventoryPlasticMovementType;
  boxes: number;
  boxesBefore: number;
  boxesAfter: number;
  unit: string;
  employeeId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
};

export type InventoryPublicStationItem = {
  id: string;
  stockCode: string;
  itemName: string;
  manufacturer: string;
  sizeLabel: string;
  boxesOnHand: number;
  unit: string;
  qtyChips: number[];
};

export type InventoryPublicStationCard = {
  kind: 'station';
  stationName: string;
  locationName: string;
  status: InventoryStationStatus;
  items: InventoryPublicStationItem[];
  employees: InventoryEmployeeOption[];
};

export type InventoryPublicLotScanCard = InventoryPublicScanCard & { kind: 'lot' };

export type InventoryPublicScanPayload = InventoryPublicLotScanCard | InventoryPublicStationCard;

export type InventoryPublicPlasticIssueResult = {
  stockCode: string;
  itemName: string;
  sizeLabel: string;
  boxesIssued: number;
  boxesOnHand: number;
  unit: string;
  employeeName: string;
};

export type InventoryAlertKind = 'expiry' | 'reorder' | 'velocity';
export type InventoryAlertSubjectType = 'lot' | 'plastic_stock';

export type InventoryAlert = {
  subjectType: InventoryAlertSubjectType;
  subjectId: string;
  alertKind: InventoryAlertKind;
  catalogItemId: string;
  catalogItemName: string;
  categoryName: string;
  locationName: string;
  title: string;
  detail: string;
  deepLink: string;
  metricValue: number | null;
  unit: string;
  /** Lot code or plastic stock code for display. */
  subjectCode: string;
};

export type InventoryAlertLogEntry = InventoryAlert & {
  id: string;
  alertDate: string;
  createdAt: string;
};

export type InventoryAlertRunResult = {
  alertDate: string;
  evaluated: number;
  newlyClaimed: number;
  skippedDuplicate: number;
  managersNotified: number;
  mailed: number;
  alerts: InventoryAlert[];
};

export type InventoryReportPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

export type InventoryNamedAmount = {
  id: string;
  name: string;
  amount: number;
};

export type InventoryUsageLeaderRow = {
  id: string;
  name: string;
  issueCount: number;
  qty: number;
  unit: string;
};

export type InventoryAdjustmentRow = {
  id: string;
  subjectType: 'lot' | 'plastic_stock';
  subjectId: string;
  subjectCode: string;
  itemName: string;
  qty: number;
  unit: string;
  notes: string;
  employeeName: string | null;
  createdAt: string;
};

export type InventoryReportsBundle = {
  range: {
    from: string;
    to: string;
    period: InventoryReportPeriod;
    label: string;
  };
  spend: {
    total: number;
    lotSpend: number;
    plasticSpend: number;
    note: string;
    byCategory: InventoryNamedAmount[];
    byLocation: InventoryNamedAmount[];
    byCatalogItem: InventoryNamedAmount[];
  };
  usage: {
    issueCount: number;
    byEmployee: InventoryUsageLeaderRow[];
    byCatalogItem: InventoryUsageLeaderRow[];
    byCategory: InventoryUsageLeaderRow[];
  };
  adjustments: {
    count: number;
    rows: InventoryAdjustmentRow[];
  };
};

export type InventoryAdminDashboard = {
  phase: number;
  title: string;
  message: string;
  range: InventoryReportsBundle['range'];
  kpis: {
    locations: number;
    catalogItems: number;
    activeLots: number;
    plasticStock: number;
    depletedLots: number;
    stations: number;
    authorizations: number;
    activeAlerts: number;
    spendInRange: number;
    issuesInRange: number;
    adjustmentsInRange: number;
  };
  stockHealth: {
    activeLots: number;
    depletedLots: number;
    voidLots: number;
    activePlastic: number;
    depletedPlastic: number;
  };
  spend: InventoryReportsBundle['spend'];
  usage: InventoryReportsBundle['usage'];
  adjustments: InventoryReportsBundle['adjustments'];
  alertQueue: InventoryAlertLogEntry[];
  activeAlerts: InventoryAlert[];
};

export type InventoryAuditExport = {
  filename: string;
  contentType: string;
  csv: string;
  rowCount: number;
  range: { from: string; to: string };
};
