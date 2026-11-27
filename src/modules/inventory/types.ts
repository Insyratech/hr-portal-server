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
  /** Manufacturer / brand (optional; searchable when set). */
  brandName: string;
  /** Supplier / internal catalogue number (optional; shown with name when set). */
  catalogNumber: string;
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
export type InventoryMovementType = 'receive' | 'issue' | 'adjust' | 'transfer';

export type InventoryStorageKind = InventoryCentralQrKind;

export type InventoryStorageLotRow = {
  id: string;
  lotCode: string;
  catalogItemName: string;
  categoryName: string;
  catalogNumber: string;
  remainingQty: number;
  receivedQty: number;
  unit: string;
  status: InventoryLotStatus;
  locationName: string;
  purchaseDate: string;
  expiryDate: string | null;
  canTransferToInsideLab: boolean;
};

export type InventoryStoragePlasticRow = {
  id: string;
  stockCode: string;
  catalogItemName: string;
  categoryName: string;
  manufacturer: string;
  sizeLabel: string;
  boxesOnHand: number;
  boxesReceived: number;
  unit: string;
  locationName: string;
};

export type InventoryStorageMovementRow = {
  id: string;
  movementType: string;
  source: 'lot' | 'plastic';
  label: string;
  qty: number;
  unit: string;
  notes: string;
  employeeName: string;
  createdAt: string;
};

export type InventoryStorageArea = {
  kind: InventoryStorageKind;
  name: string;
  description: string;
  lots: InventoryStorageLotRow[];
  plastic: InventoryStoragePlasticRow[];
  recentMovements: InventoryStorageMovementRow[];
};

export type InventoryLotTransferResult = {
  lot: InventoryLot;
  fromArea: string;
  toArea: string;
};
export type InventoryPrepStatus = 'open' | 'completed' | 'cancelled';

/** method = DNA/PCR/Loading with Nx; recipe = reagent prep; gel = % + volume chart. */
export type InventoryLabUsageMode = 'method' | 'recipe' | 'gel';

export type InventoryLabGelComponentKey = 'agarose' | 'buffer' | 'stain';

export type InventoryLabActivity = {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  status: InventoryStatus;
  usageMode: InventoryLabUsageMode;
  recipeCount: number;
  createdAt: string;
  updatedAt: string;
};

export type InventoryLabGelComponentLink = {
  id: string;
  activityId: string;
  componentKey: InventoryLabGelComponentKey;
  name: string;
  catalogItemId: string | null;
  catalogItemName: string;
  sortOrder: number;
};

export type InventoryLabGelChart = {
  activityId: string;
  percentages: number[];
  volumesMl: number[];
  etbrUlByVolumeMl: Record<string, number>;
  components: InventoryLabGelComponentLink[];
};

export type InventoryLabRecipeComponent = {
  id: string;
  recipeId: string;
  name: string;
  quantityValue: number | null;
  quantityUnit: string;
  notes: string;
  sortOrder: number;
  catalogItemId: string | null;
  catalogItemName: string;
  createdAt: string;
  updatedAt: string;
};

export type InventoryLabRecipe = {
  id: string;
  activityId: string;
  activityName: string;
  name: string;
  finalVolumeValue: number | null;
  finalVolumeUnit: string;
  notes: string;
  sortOrder: number;
  status: InventoryStatus;
  createsOutputLot: boolean;
  outputCatalogItemId: string | null;
  outputCatalogItemName: string;
  sopFileId: string | null;
  sopTitle: string;
  components: InventoryLabRecipeComponent[];
  createdAt: string;
  updatedAt: string;
};

export type InventorySopFolder = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  status: InventoryStatus;
  fileCount: number;
  childCount: number;
  createdAt: string;
  updatedAt: string;
};

export type InventorySopFile = {
  id: string;
  folderId: string;
  title: string;
  originalFileName: string;
  contentType: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  compression: 'zstd';
  createdAt: string;
  updatedAt: string;
};

export type InventorySopFileContent = {
  id: string;
  title: string;
  fileName: string;
  contentType: string;
  contentBase64: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
};

export type InventoryLabUsageComponentLine = {
  name: string;
  quantityValue: number | null;
  quantityUnit: string;
  notes: string;
  catalogItemId: string | null;
  lotId: string | null;
  qtyDeducted: number | null;
};

export type InventoryLabUsageResult = {
  id: string;
  activityName: string;
  recipeName: string;
  employeeName: string;
  employeeCode: string;
  outputLotCode: string | null;
  components: InventoryLabUsageComponentLine[];
};

export type InventoryCentralQrKind = 'stock_room' | 'stationery' | 'inside_lab';

export type InventoryCentralQr = {
  id: string;
  kind: InventoryCentralQrKind;
  name: string;
  qrToken: string;
  status: InventoryStatus;
  notes: string;
  scanPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InventoryCentralQrPrint = {
  central: InventoryCentralQr;
  scanUrl: string;
  labelTitle: string;
};

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
  /** Usage area this lot is attached to for usage. */
  centralQrId: string | null;
  centralQrKind: InventoryCentralQrKind | null;
  centralQrName: string;
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
  /** Supplier catalogue number copied from the catalog item. */
  catalogNumber: string;
  /** When the container was opened. Empty until someone records it. */
  openedOn: string | null;
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
  catalogNumber: string;
  openedOn: string | null;
  /** Purchase date, or the day a lab reagent was prepared. */
  madeOn: string;
  /** "Mfg" for a purchased lot, "Prepared" for a lab reagent. */
  madeLabel: 'Mfg' | 'Prepared';
  status: InventoryLotStatus;
  employees: InventoryEmployeeOption[];
  /** Bottle QRs no longer issue stock — use the usage area instead. */
  issueDisabled?: boolean;
  issueDisabledMessage?: string;
};

export type InventoryPublicCentralLotItem = {
  id: string;
  lotCode: string;
  itemName: string;
  categoryName: string;
  catalogNumber: string;
  remainingQty: number;
  unit: string;
  qtyChips: number[];
  expiryDate: string | null;
};

export type InventoryPublicCentralCard = {
  kind: 'central';
  centralKind: 'stock_room' | 'stationery';
  name: string;
  lots: InventoryPublicCentralLotItem[];
  plasticItems: InventoryPublicStationItem[];
  employees: InventoryEmployeeOption[];
};

export type InventoryPublicCentralLabCard = {
  kind: 'central_lab';
  centralKind: 'inside_lab';
  name: string;
  message: string;
  activities: InventoryLabActivity[];
  employees: InventoryEmployeeOption[];
};

export type InventoryPublicIssueResult = {
  lotCode: string;
  qtyIssued: number;
  remainingQty: number;
  unit: string;
  employeeName: string;
};

export type InventoryPublicTransferResult = {
  lotCode: string;
  itemName: string;
  remainingQty: number;
  unit: string;
  fromArea: string;
  toArea: string;
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
  /** Box category printed on the usage area. Empty until migration 094 is applied. */
  categoryId: string | null;
  categoryName: string;
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
  /** Usage area this box stock is attached to for usage. */
  centralQrId: string | null;
  centralQrKind: InventoryCentralQrKind | null;
  centralQrName: string;
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
  categoryName: string;
  status: InventoryStationStatus;
  items: InventoryPublicStationItem[];
  employees: InventoryEmployeeOption[];
};

export type InventoryPublicLotScanCard = InventoryPublicScanCard & { kind: 'lot' };

export type InventoryPublicScanPayload =
  | InventoryPublicLotScanCard
  | InventoryPublicStationCard
  | InventoryPublicCentralCard
  | InventoryPublicCentralLabCard;

export type InventoryPublicPlasticIssueResult = {
  stockCode: string;
  itemName: string;
  sizeLabel: string;
  boxesIssued: number;
  boxesOnHand: number;
  unit: string;
  employeeName: string;
};

export type InventoryPublicPlasticIssueBatchResult = {
  employeeName: string;
  lines: InventoryPublicPlasticIssueResult[];
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

export type InventoryLogPlasticIssueRow = {
  id: string;
  createdAt: string;
  employeeName: string;
  employeeCode: string;
  itemName: string;
  sizeLabel: string;
  boxes: number;
  boxesAfter: number;
  notes: string;
  areaName: string;
};

export type InventoryLogLotTransferRow = {
  id: string;
  createdAt: string;
  employeeName: string;
  employeeCode: string;
  lotCode: string;
  itemName: string;
  qty: number;
  unit: string;
  notes: string;
  fromArea: string;
  toArea: string;
};

export type InventoryLogLabComponentRow = {
  name: string;
  quantityValue: number | null;
  quantityUnit: string;
  notes: string;
  catalogItemName: string;
  qtyDeducted: number | null;
};

export type InventoryLogLabSubmissionRow = {
  id: string;
  createdAt: string;
  employeeName: string;
  employeeCode: string;
  activityName: string;
  usageMode: InventoryLabUsageMode;
  /** Method / recipe name, or gel run label (e.g. 2% · 50 mL). */
  runName: string;
  quantityMultiplier: number;
  gelPercent: number | null;
  gelVolumeMl: number | null;
  notes: string;
  outputLotCode: string;
  components: InventoryLogLabComponentRow[];
};

export type InventoryLogInsideLabActivitySection = {
  activityId: string;
  activityName: string;
  usageMode: InventoryLabUsageMode;
  submissions: InventoryLogLabSubmissionRow[];
};

export type InventoryLogsBundle = {
  range: InventoryReportsBundle['range'];
  stockRoom: {
    areaName: string;
    plasticIssues: InventoryLogPlasticIssueRow[];
    lotTransfers: InventoryLogLotTransferRow[];
  };
  stationery: {
    areaName: string;
    plasticIssues: InventoryLogPlasticIssueRow[];
  };
  insideLab: {
    areaName: string;
    byActivity: InventoryLogInsideLabActivitySection[];
  };
};

export type InventoryLogsExcelExport = {
  filename: string;
  contentType: string;
  contentBase64: string;
  sheetCount: number;
  range: { from: string; to: string };
};
