import type { SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { canViewReports } from './access';
import { resolveInventoryReportRange } from './reports-service';
import type {
  InventoryLabUsageMode,
  InventoryLogInsideLabActivitySection,
  InventoryLogLabComponentRow,
  InventoryLogLabSubmissionRow,
  InventoryLogLotTransferRow,
  InventoryLogPlasticIssueRow,
  InventoryLogsBundle,
  InventoryLogsExcelExport,
} from './types';

const ROW_LIMIT = 2500;

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function asNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function mapUsageMode(value: string | null | undefined): InventoryLabUsageMode {
  if (value === 'recipe') return 'recipe';
  if (value === 'gel') return 'gel';
  return 'method';
}

function rangeBounds(from: string, to: string): { startIso: string; endExclusiveIso: string } {
  return {
    startIso: `${from}T00:00:00.000Z`,
    endExclusiveIso: `${to}T23:59:59.999Z`,
  };
}

function formatComponentsCell(components: InventoryLogLabComponentRow[]): string {
  return components
    .map((row) => {
      const qty =
        row.quantityValue === null || row.quantityValue === undefined
          ? ''
          : `${row.quantityValue}${row.quantityUnit ? ` ${row.quantityUnit}` : ''}`;
      const deducted =
        row.qtyDeducted === null || row.qtyDeducted === undefined
          ? ''
          : ` (deducted ${row.qtyDeducted})`;
      return `${row.name}${qty ? `: ${qty}` : ''}${deducted}`.trim();
    })
    .join(' | ');
}

function sheetNameSafe(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 26)}_${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

export function createInventoryLogsService(supabase: SupabaseClient) {
  async function loadBundle(
    actor: RequestUser,
    query: { period?: string; from?: string; to?: string },
  ): Promise<InventoryLogsBundle> {
    if (!canViewReports(actor)) {
      throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view inventory logs.', 403);
    }

    const range = resolveInventoryReportRange(query);
    const { startIso, endExclusiveIso } = rangeBounds(range.from, range.to);

    const { data: centralRows, error: centralError } = await supabase
      .from('inventory_central_qrs')
      .select('id, kind, name')
      .in('kind', ['stock_room', 'stationery', 'inside_lab']);
    if (centralError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load usage areas.', 500);
    }
    const centrals = (centralRows ?? []) as Array<{ id: string; kind: string; name: string }>;
    const stockRoom = centrals.find((row) => row.kind === 'stock_room');
    const stationery = centrals.find((row) => row.kind === 'stationery');
    const insideLab = centrals.find((row) => row.kind === 'inside_lab');

    type PlasticIssueInternal = InventoryLogPlasticIssueRow & { areaKind: string };
    const plasticIssues: PlasticIssueInternal[] = [];
    if (stockRoom || stationery) {
      const areaIds = [stockRoom?.id, stationery?.id].filter(Boolean) as string[];
      const { data: plasticRows, error: plasticError } = await supabase
        .from('inventory_plastic_movements')
        .select(
          `
          id, created_at, boxes, boxes_after, notes, movement_type,
          employees ( full_name, employee_code ),
          inventory_plastic_stock!inner (
            size_label, manufacturer, central_qr_id,
            inventory_catalog_items ( name ),
            inventory_central_qrs ( kind, name )
          )
        `,
        )
        .eq('movement_type', 'issue')
        .in('inventory_plastic_stock.central_qr_id', areaIds)
        .gte('created_at', startIso)
        .lte('created_at', endExclusiveIso)
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT);
      if (plasticError) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          plasticError.message ?? 'Failed to load plastic issue log.',
          500,
        );
      }
      for (const row of (plasticRows ?? []) as Array<Record<string, unknown>>) {
        const employee = one(row.employees as { full_name: string; employee_code: string } | null);
        const stock = one(
          row.inventory_plastic_stock as
            | {
                size_label: string;
                manufacturer: string | null;
                central_qr_id: string;
                inventory_catalog_items: { name: string } | { name: string }[] | null;
                inventory_central_qrs:
                  | { kind: string; name: string }
                  | { kind: string; name: string }[]
                  | null;
              }
            | null,
        );
        const catalog = one(stock?.inventory_catalog_items ?? null);
        const area = one(stock?.inventory_central_qrs ?? null);
        plasticIssues.push({
          id: String(row.id),
          createdAt: String(row.created_at),
          employeeName: employee?.full_name ?? '',
          employeeCode: employee?.employee_code ?? '',
          itemName: catalog?.name ?? '',
          sizeLabel: stock?.size_label ?? '',
          boxes: asNumber(row.boxes as number | string),
          boxesAfter: asNumber(row.boxes_after as number | string),
          notes: String(row.notes ?? ''),
          areaName: area?.name ?? '',
          areaKind: area?.kind ?? '',
        });
      }
    }

    const toPublicPlastic = (rows: PlasticIssueInternal[]): InventoryLogPlasticIssueRow[] =>
      rows.map(({ areaKind: _areaKind, ...row }) => row);
    const stockRoomIssues = toPublicPlastic(
      plasticIssues.filter((row) => row.areaKind === 'stock_room'),
    );
    const stationeryIssues = toPublicPlastic(
      plasticIssues.filter((row) => row.areaKind === 'stationery'),
    );

    const lotTransfers: InventoryLogLotTransferRow[] = [];
    {
      const { data: transferRows, error: transferError } = await supabase
        .from('inventory_movements')
        .select(
          `
          id, created_at, qty, unit, notes, movement_type,
          employees ( full_name, employee_code ),
          inventory_lots ( lot_code, inventory_catalog_items ( name ) )
        `,
        )
        .eq('movement_type', 'transfer')
        .gte('created_at', startIso)
        .lte('created_at', endExclusiveIso)
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT);
      if (transferError) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          transferError.message ?? 'Failed to load transfer log.',
          500,
        );
      }
      for (const row of (transferRows ?? []) as Array<Record<string, unknown>>) {
        const employee = one(row.employees as { full_name: string; employee_code: string } | null);
        const lot = one(
          row.inventory_lots as
            | {
                lot_code: string;
                inventory_catalog_items: { name: string } | { name: string }[] | null;
              }
            | null,
        );
        const catalog = one(lot?.inventory_catalog_items ?? null);
        lotTransfers.push({
          id: String(row.id),
          createdAt: String(row.created_at),
          employeeName: employee?.full_name ?? '',
          employeeCode: employee?.employee_code ?? '',
          lotCode: lot?.lot_code ?? '',
          itemName: catalog?.name ?? '',
          qty: asNumber(row.qty as number | string),
          unit: String(row.unit ?? ''),
          notes: String(row.notes ?? ''),
          fromArea: stockRoom?.name ?? 'Stock room',
          toArea: insideLab?.name ?? 'Inside lab',
        });
      }
    }

    const { data: activityRows, error: activityError } = await supabase
      .from('inventory_lab_activities')
      .select('id, name, usage_mode, sort_order, status')
      .order('sort_order')
      .order('name');
    if (activityError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lab work types.', 500);
    }
    const activities = (activityRows ?? []) as Array<{
      id: string;
      name: string;
      usage_mode: string | null;
      status: string;
    }>;

    const { data: submissionRows, error: submissionError } = await supabase
      .from('inventory_lab_usage_submissions')
      .select(
        `
        id, created_at, activity_id, activity_name, recipe_name, notes,
        quantity_multiplier, gel_percent, gel_volume_ml, components_snapshot,
        employees ( full_name, employee_code ),
        output_lot:inventory_lots!output_lot_id ( lot_code ),
        inventory_lab_activities ( id, name, usage_mode )
      `,
      )
      .gte('created_at', startIso)
      .lte('created_at', endExclusiveIso)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT);
    if (submissionError) {
      throw new AppError(
        API_ERROR_CODES.INTERNAL_ERROR,
        submissionError.message ?? 'Failed to load Inside lab usage log.',
        500,
      );
    }

    const submissionsByActivity = new Map<string, InventoryLogLabSubmissionRow[]>();
    for (const row of (submissionRows ?? []) as Array<Record<string, unknown>>) {
      const employee = one(row.employees as { full_name: string; employee_code: string } | null);
      const activity = one(
        row.inventory_lab_activities as
          | { id: string; name: string; usage_mode: string | null }
          | null,
      );
      const outputLot = one(row.output_lot as { lot_code: string } | null);
      const activityId = String(row.activity_id ?? activity?.id ?? '');
      const usageMode = mapUsageMode(activity?.usage_mode);
      const snapshot = Array.isArray(row.components_snapshot) ? row.components_snapshot : [];
      const components: InventoryLogLabComponentRow[] = snapshot.map((line) => {
        const item = line as Record<string, unknown>;
        return {
          name: String(item.name ?? ''),
          quantityValue: asNumberOrNull(item.quantityValue as number | string | null),
          quantityUnit: String(item.quantityUnit ?? ''),
          notes: String(item.notes ?? ''),
          catalogItemName: String(item.catalogItemName ?? ''),
          qtyDeducted: asNumberOrNull(item.qtyDeducted as number | string | null),
        };
      });

      const mapped: InventoryLogLabSubmissionRow = {
        id: String(row.id),
        createdAt: String(row.created_at),
        employeeName: employee?.full_name ?? '',
        employeeCode: employee?.employee_code ?? '',
        activityName: String(row.activity_name || activity?.name || ''),
        usageMode,
        runName: String(row.recipe_name ?? ''),
        quantityMultiplier: asNumber(row.quantity_multiplier as number | string) || 1,
        gelPercent: asNumberOrNull(row.gel_percent as number | string | null),
        gelVolumeMl: asNumberOrNull(row.gel_volume_ml as number | string | null),
        notes: String(row.notes ?? ''),
        outputLotCode: outputLot?.lot_code ?? '',
        components,
      };
      const list = submissionsByActivity.get(activityId) ?? [];
      list.push(mapped);
      submissionsByActivity.set(activityId, list);
    }

    const byActivity: InventoryLogInsideLabActivitySection[] = activities.map((activity) => ({
      activityId: activity.id,
      activityName: activity.name,
      usageMode: mapUsageMode(activity.usage_mode),
      submissions: submissionsByActivity.get(activity.id) ?? [],
    }));

    // Include any submissions whose activity was deleted / missing from the list.
    for (const [activityId, submissions] of submissionsByActivity) {
      if (byActivity.some((section) => section.activityId === activityId)) continue;
      const first = submissions[0];
      byActivity.push({
        activityId,
        activityName: first?.activityName || 'Unknown work type',
        usageMode: first?.usageMode ?? 'method',
        submissions,
      });
    }

    return {
      range,
      stockRoom: {
        areaName: stockRoom?.name ?? 'Stock room',
        plasticIssues: stockRoomIssues,
        lotTransfers,
      },
      stationery: {
        areaName: stationery?.name ?? 'Stationery',
        plasticIssues: stationeryIssues,
      },
      insideLab: {
        areaName: insideLab?.name ?? 'Inside lab',
        byActivity,
      },
    };
  }

  function buildWorkbook(bundle: InventoryLogsBundle): Buffer {
    const workbook = XLSX.utils.book_new();
    const usedNames = new Set<string>();

    const plasticHeaders = [
      'When (UTC)',
      'Employee',
      'Employee ID',
      'Item',
      'Size',
      'Boxes taken',
      'Boxes left',
      'Notes',
      'Area',
    ];
    const plasticSheet = (rows: InventoryLogPlasticIssueRow[], title: string) => {
      const aoa: Array<Array<string | number>> = [
        plasticHeaders,
        ...rows.map((row) => [
          row.createdAt,
          row.employeeName,
          row.employeeCode,
          row.itemName,
          row.sizeLabel,
          row.boxes,
          row.boxesAfter,
          row.notes,
          row.areaName,
        ]),
      ];
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet(aoa),
        sheetNameSafe(title, usedNames),
      );
    };

    plasticSheet(bundle.stockRoom.plasticIssues, `${bundle.stockRoom.areaName} plastic`);

    const transferAoa: Array<Array<string | number>> = [
      [
        'When (UTC)',
        'Employee',
        'Employee ID',
        'Lot',
        'Item',
        'Qty moved',
        'Unit',
        'From',
        'To',
        'Notes',
      ],
      ...bundle.stockRoom.lotTransfers.map((row) => [
        row.createdAt,
        row.employeeName,
        row.employeeCode,
        row.lotCode,
        row.itemName,
        row.qty,
        row.unit,
        row.fromArea,
        row.toArea,
        row.notes,
      ]),
    ];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(transferAoa),
      sheetNameSafe(`${bundle.stockRoom.areaName} transfers`, usedNames),
    );

    plasticSheet(bundle.stationery.plasticIssues, `${bundle.stationery.areaName} plastic`);

    for (const section of bundle.insideLab.byActivity) {
      const headers =
        section.usageMode === 'gel'
          ? [
              'When (UTC)',
              'Employee',
              'Employee ID',
              'Agarose %',
              'Volume (mL)',
              'Run label',
              'Components',
              'Notes',
            ]
          : section.usageMode === 'method'
            ? [
                'When (UTC)',
                'Employee',
                'Employee ID',
                'Method',
                'How many (Nx)',
                'Components',
                'Notes',
              ]
            : [
                'When (UTC)',
                'Employee',
                'Employee ID',
                'Recipe',
                'Components',
                'Output lot',
                'Notes',
              ];

      const aoa: Array<Array<string | number>> = [
        headers,
        ...section.submissions.map((row) => {
          const components = formatComponentsCell(row.components);
          if (section.usageMode === 'gel') {
            return [
              row.createdAt,
              row.employeeName,
              row.employeeCode,
              row.gelPercent ?? '',
              row.gelVolumeMl ?? '',
              row.runName,
              components,
              row.notes,
            ];
          }
          if (section.usageMode === 'method') {
            return [
              row.createdAt,
              row.employeeName,
              row.employeeCode,
              row.runName,
              row.quantityMultiplier,
              components,
              row.notes,
            ];
          }
          return [
            row.createdAt,
            row.employeeName,
            row.employeeCode,
            row.runName,
            components,
            row.outputLotCode,
            row.notes,
          ];
        }),
      ];
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet(aoa),
        sheetNameSafe(`Lab ${section.activityName}`, usedNames),
      );
    }

    return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  }

  return {
    async getLogs(
      actor: RequestUser,
      query: { period?: string; from?: string; to?: string },
    ): Promise<InventoryLogsBundle> {
      return loadBundle(actor, query);
    },

    async exportExcel(
      actor: RequestUser,
      query: { period?: string; from?: string; to?: string },
    ): Promise<InventoryLogsExcelExport> {
      const bundle = await loadBundle(actor, query);
      const buffer = buildWorkbook(bundle);
      const filename = `inventory-logs-${bundle.range.from}_to_${bundle.range.to}.xlsx`;
      return {
        filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBase64: buffer.toString('base64'),
        sheetCount:
          3 +
          bundle.insideLab.byActivity.length,
        range: { from: bundle.range.from, to: bundle.range.to },
      };
    },
  };
}
