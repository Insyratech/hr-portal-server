/**
 * Sandip-only ephemeral payslip playground (employee self-service).
 * No DB writes of playground slips, no payroll audit logs.
 * Production payroll untouched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { parsePeriod } from '../attendance/import/period';
import { mapCompensation } from '../employees/master';
import { formatIsoDateInZone } from '../work/ist-clock';
import { amountInWordsInr } from './amount-in-words';
import { calculateSlipMoney, grossPay, roundMoney, snapshotPayment, type CompensationParts } from './calc';
import {
  computeNewRegimeAnnualTax,
  financialYearForPeriod,
  monthsLeftInFy,
  projectAnnualGrossSalary,
  type AnnualTaxResult,
} from './new-regime-tax';
import {
  countMissingPriorMonths,
  expectedYtdPeriods,
  filterSlipsForYtd,
  joiningPeriodFromDate,
  resolvePlaygroundTds,
  sumYtdFromSlips,
  type PlaygroundYtdTotals,
} from './playground-ytd';

export const PLAYGROUND_EMPLOYEE_CODE = 'ID2025009';
export const PLAYGROUND_EMPLOYEE_NAME = 'Sandip Kumar Yadav';

const LOGO_BUCKET = 'company-logos';

export type PlaygroundLeaveRow = {
  code: string;
  name: string;
  opening: number;
  accrued: number;
  availed: number;
  closing: number;
};

/** Published slip summary for YTD awareness in the Phase 1 seed shell. */
export type PlaygroundPublishedSlip = {
  id: string;
  period: string;
  monthLabel: string;
  gross: number;
  net: number;
  tds: number;
  basic: number;
  da: number;
  hra: number;
  fuel: number;
  incentives: number;
  other: number;
  professionalTax: number;
  employeeWelfare: number;
  otherDeductions: number;
  lopAmount: number;
};

export type PlaygroundYtd = PlaygroundYtdTotals;

export type PlaygroundSeed = {
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    designationName: string | null;
    departmentName: string | null;
    joiningDate: string | null;
  };
  company: {
    name: string;
    address: string;
    logoPath: string | null;
    logoUrl: string | null;
  };
  payment: {
    pan: string | null;
    bankAccountNumber: string | null;
    bankName: string | null;
    ifsc: string | null;
  };
  compensation: CompensationParts;
  leave: PlaygroundLeaveRow[];
  /** Published slips (newest first) — used for YTD when previewing a month. */
  publishedSlips: PlaygroundPublishedSlip[];
  suggestedPeriod: string;
};

export type PlaygroundPreviewInput = {
  period: string;
  calendarDays?: number;
  workingDays: number;
  lopDays: number;
  basic: number;
  da: number;
  hra: number;
  fuel: number;
  incentives: number;
  other: number;
  professionalTax: number;
  employeeWelfare: number;
  otherDeductions: number;
  /** Optional manual TDS override; omit/null → computed new-regime TDS. */
  tdsOverride?: number | null;
  otherIncomeAnnual?: number;
  relief89?: number;
};

export type PlaygroundLine = { label: string; amount: number; ytd: number };

export type PlaygroundPreview = {
  period: string;
  monthLabel: string;
  financialYear: string;
  taxRegime: 'new';
  ephemeral: true;
  employee: PlaygroundSeed['employee'];
  company: PlaygroundSeed['company'];
  payment: PlaygroundSeed['payment'];
  attendance: {
    calendarDays: number;
    workingDays: number;
    nonWorkingDays: number;
    lopDays: number;
  };
  earnings: PlaygroundLine[];
  deductions: PlaygroundLine[];
  gross: number;
  grossYtd: number;
  dailyRate: number;
  nonWorkingAmount: number;
  lopAmount: number;
  net: number;
  netInWords: string;
  tdsSource: 'computed' | 'override';
  tds: number;
  leave: PlaygroundLeaveRow[];
  ytd: PlaygroundYtd;
  tax: AnnualTaxResult;
};

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function signedLogo(supabase: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(LOGO_BUCKET).createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

async function requirePlaygroundActor(
  supabase: SupabaseClient,
  actor: RequestUser,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('employees')
    .select(
      'id, employee_code, full_name, joining_date, company_id, designation_id, department_id, companies (name, address, logo_storage_path), designations (name), departments (name)',
    )
    .eq('id', actor.employeeId)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Payslip playground is not available.', 403);
  }
  const code = String(data.employee_code ?? '');
  const name = String(data.full_name ?? '');
  if (code !== PLAYGROUND_EMPLOYEE_CODE || name !== PLAYGROUND_EMPLOYEE_NAME) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Payslip playground is not available.', 403);
  }
  return data as Record<string, unknown>;
}

function defaultCompensation(): CompensationParts {
  return {
    basic: 0,
    da: 0,
    hra: 0,
    fuel: 0,
    incentives: 0,
    other: 0,
    professionalTax: 0,
    tds: 0,
    employeeWelfare: 0,
    kpi: 0,
    otherDeductions: 0,
  };
}

function mapLeaveRows(rows: Record<string, unknown>[]): PlaygroundLeaveRow[] {
  return rows.map((row) => {
    const type = firstRel(row.leave_types as { code?: string; name?: string } | { code?: string; name?: string }[]);
    const allocated = Number(row.allocated ?? 0);
    const carried = Number(row.carried_forward ?? 0);
    const adjusted = Number(row.adjusted ?? 0);
    const used = Number(row.used ?? 0);
    const available = Number(row.available ?? 0);
    return {
      code: type?.code ?? '',
      name: type?.name ?? '',
      opening: roundMoney(carried),
      accrued: roundMoney(allocated + adjusted),
      availed: used,
      closing: available,
    };
  });
}

function mapPublishedSlip(row: Record<string, unknown>, period: string): PlaygroundPublishedSlip {
  let monthLabel = period;
  try {
    monthLabel = parsePeriod(period).label;
  } catch {
    /* keep period key */
  }
  return {
    id: String(row.id ?? ''),
    period,
    monthLabel,
    gross: Number(row.gross ?? 0),
    net: Number(row.net ?? 0),
    tds: Number(row.tds ?? 0),
    basic: Number(row.basic ?? 0),
    da: Number(row.da ?? 0),
    hra: Number(row.hra ?? 0),
    fuel: Number(row.fuel ?? 0),
    incentives: Number(row.incentives ?? 0),
    other: Number(row.other_earnings ?? 0),
    professionalTax: Number(row.professional_tax ?? 0),
    employeeWelfare: Number(row.employee_welfare ?? 0),
    otherDeductions: Number(row.other_deductions ?? 0),
    lopAmount: Number(row.lop_amount ?? 0),
  };
}

async function loadPublishedSlips(
  supabase: SupabaseClient,
  employeeId: string,
): Promise<PlaygroundPublishedSlip[]> {
  const { data, error } = await supabase
    .from('salary_slips')
    .select(
      'id, basic, da, hra, fuel, incentives, other_earnings, professional_tax, tds, employee_welfare, other_deductions, lop_amount, gross, net, payroll_runs (period, status)',
    )
    .eq('employee_id', employeeId);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load published slips.', 500);
  }

  const slips: PlaygroundPublishedSlip[] = [];
  for (const row of data ?? []) {
    const run = firstRel(
      row.payroll_runs as { period?: string; status?: string } | { period?: string; status?: string }[],
    );
    if (run?.status !== 'PUBLISHED' || !run.period) continue;
    slips.push(mapPublishedSlip(row as Record<string, unknown>, run.period));
  }
  slips.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  return slips;
}

function suggestedPeriodIst(now = new Date()): string {
  const iso = formatIsoDateInZone(now);
  return iso.slice(0, 7);
}

export function createPayrollPlaygroundService(supabase: SupabaseClient) {
  return {
    async seed(actor: RequestUser): Promise<PlaygroundSeed> {
      const emp = await requirePlaygroundActor(supabase, actor);
      const company = firstRel(
        emp.companies as
          | { name?: string; address?: string; logo_storage_path?: string | null }
          | { name?: string; address?: string; logo_storage_path?: string | null }[],
      );
      const designation = firstRel(emp.designations as { name?: string } | { name?: string }[]);
      const department = firstRel(emp.departments as { name?: string } | { name?: string }[]);
      const logoPath = (company?.logo_storage_path as string | null | undefined) ?? null;

      const suggestedPeriod = suggestedPeriodIst();
      const periodEnd = parsePeriod(suggestedPeriod).end;
      const leavePeriod = String(Number(suggestedPeriod.slice(0, 4)));

      const [{ data: compRow }, { data: payment }, { data: leaveRows }, publishedSlips] = await Promise.all([
        supabase
          .from('employee_compensation')
          .select('*')
          .eq('employee_id', actor.employeeId)
          .lte('effective_from', periodEnd)
          .order('effective_from', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('employee_payment')
          .select('pan, bank_account_number, bank_name, ifsc')
          .eq('employee_id', actor.employeeId)
          .maybeSingle(),
        supabase
          .from('leave_allocations')
          .select('allocated, carried_forward, adjusted, used, available, leave_types (code, name)')
          .eq('employee_id', actor.employeeId)
          .eq('period', leavePeriod),
        loadPublishedSlips(supabase, actor.employeeId),
      ]);

      let compensation = defaultCompensation();
      if (compRow) {
        const mapped = mapCompensation(compRow as never);
        compensation = {
          basic: mapped.basic,
          da: mapped.da,
          hra: mapped.hra,
          fuel: mapped.fuel,
          incentives: mapped.incentives,
          other: mapped.other,
          professionalTax: mapped.professionalTax,
          tds: mapped.tds,
          employeeWelfare: mapped.employeeWelfare,
          kpi: 0,
          otherDeductions: mapped.otherDeductions,
        };
      }

      const paySnap = snapshotPayment({
        pan: payment?.pan as string | null,
        bankAccountNumber: payment?.bank_account_number as string | null,
        bankName: payment?.bank_name as string | null,
        ifsc: payment?.ifsc as string | null,
      });

      return {
        employee: {
          id: emp.id as string,
          employeeCode: emp.employee_code as string,
          fullName: emp.full_name as string,
          designationName: designation?.name ?? null,
          departmentName: department?.name ?? null,
          joiningDate: emp.joining_date ? String(emp.joining_date).slice(0, 10) : null,
        },
        company: {
          name: company?.name ?? '',
          address: company?.address ?? '',
          logoPath,
          logoUrl: await signedLogo(supabase, logoPath),
        },
        payment: {
          pan: paySnap.panMasked,
          bankAccountNumber: paySnap.bankAccountMasked,
          bankName: paySnap.bankNameMasked,
          ifsc: paySnap.ifscMasked,
        },
        compensation,
        leave: mapLeaveRows((leaveRows ?? []) as Record<string, unknown>[]),
        publishedSlips,
        suggestedPeriod,
      };
    },

    async preview(actor: RequestUser, input: PlaygroundPreviewInput): Promise<PlaygroundPreview> {
      const seed = await this.seed(actor);
      const period = parsePeriod(input.period);
      const fy = financialYearForPeriod(period.key);
      const calendarMonth = Number(period.key.slice(5, 7));
      const monthsLeft = monthsLeftInFy(calendarMonth);
      const daysInMonth =
        input.calendarDays != null ? Math.max(1, Math.floor(input.calendarDays)) : Number(period.end.slice(-2));

      const joinPeriod = joiningPeriodFromDate(seed.employee.joiningDate);
      if (joinPeriod && period.key < joinPeriod) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Playground month cannot be before joining (${joinPeriod}).`,
          400,
        );
      }

      const compensation: CompensationParts = {
        basic: roundMoney(input.basic),
        da: roundMoney(input.da),
        hra: roundMoney(input.hra),
        fuel: roundMoney(input.fuel),
        incentives: roundMoney(input.incentives),
        other: roundMoney(input.other),
        professionalTax: roundMoney(input.professionalTax),
        tds: 0,
        employeeWelfare: roundMoney(input.employeeWelfare),
        kpi: 0,
        otherDeductions: roundMoney(input.otherDeductions),
      };

      const moneyBeforeTds = calculateSlipMoney({
        compensation,
        calendarDays: daysInMonth,
        workingDays: input.workingDays,
        lopDays: input.lopDays,
      });

      const priorSlips = filterSlipsForYtd(seed.publishedSlips, period.key, joinPeriod);
      const ytd = sumYtdFromSlips(priorSlips);
      const missingPriorMonths = countMissingPriorMonths(
        expectedYtdPeriods(period.key, joinPeriod),
        ytd.periods,
      );

      const leavePeriod = String(Number(period.key.slice(0, 4)));
      const { data: leaveRows } = await supabase
        .from('leave_allocations')
        .select('allocated, carried_forward, adjusted, used, available, leave_types (code, name)')
        .eq('employee_id', actor.employeeId)
        .eq('period', leavePeriod);
      const leave = mapLeaveRows((leaveRows ?? []) as Record<string, unknown>[]);

      const fixedMonthly = roundMoney(
        compensation.basic + compensation.da + compensation.hra + compensation.fuel + compensation.other,
      );
      // LOP reduces this month's taxable earnings (and net via calculateSlipMoney).
      const thisMonthEarnings = roundMoney(grossPay(compensation) - moneyBeforeTds.lopAmount);
      const annualGrossSalary = projectAnnualGrossSalary({
        ytdEarnings: ytd.earnings,
        thisMonthEarnings,
        fixedMonthly,
        monthsLeftIncludingThis: monthsLeft,
        missingPriorMonths,
      });

      const tax = computeNewRegimeAnnualTax({
        annualGrossSalary,
        otherIncome: input.otherIncomeAnnual ?? 0,
        relief89: input.relief89 ?? 0,
        taxDeductedTillPreviousMonth: ytd.tds,
        monthsLeftIncludingThis: monthsLeft,
      });

      const { tds, source: tdsSource } = resolvePlaygroundTds(tax.tdsThisMonth, input.tdsOverride);

      const money = calculateSlipMoney({
        compensation: { ...compensation, tds },
        calendarDays: daysInMonth,
        workingDays: input.workingDays,
        lopDays: input.lopDays,
      });

      const line = (label: string, amount: number, ytdAmount: number): PlaygroundLine => ({
        label,
        amount,
        ytd: ytdAmount,
      });

      const earnings: PlaygroundLine[] = [
        line('Basic', compensation.basic, roundMoney(ytd.basic + compensation.basic)),
        line('DA', compensation.da, roundMoney(ytd.da + compensation.da)),
        line('HRA', compensation.hra, roundMoney(ytd.hra + compensation.hra)),
        line('Fuel', compensation.fuel, roundMoney(ytd.fuel + compensation.fuel)),
        line('Incentives', compensation.incentives, roundMoney(ytd.incentives + compensation.incentives)),
        line('Other', compensation.other, roundMoney(ytd.other + compensation.other)),
      ];

      const deductions: PlaygroundLine[] = [
        line(
          'Professional tax',
          compensation.professionalTax,
          roundMoney(ytd.professionalTax + compensation.professionalTax),
        ),
        line('TDS', tds, roundMoney(ytd.tds + tds)),
        line(
          'Employee welfare',
          compensation.employeeWelfare,
          roundMoney(ytd.employeeWelfare + compensation.employeeWelfare),
        ),
        line('Other', compensation.otherDeductions, roundMoney(ytd.otherDeductions + compensation.otherDeductions)),
        line(`Non-working days (${money.nonWorkingDays})`, money.nonWorkingAmount, money.nonWorkingAmount),
        line('LOP', money.lopAmount, roundMoney(ytd.lopAmount + money.lopAmount)),
      ];

      return {
        period: period.key,
        monthLabel: period.label,
        financialYear: fy.label,
        taxRegime: 'new',
        ephemeral: true,
        employee: seed.employee,
        company: seed.company,
        payment: seed.payment,
        attendance: {
          calendarDays: daysInMonth,
          workingDays: money.workingDays,
          nonWorkingDays: money.nonWorkingDays,
          lopDays: input.lopDays,
        },
        earnings,
        deductions,
        gross: money.gross,
        grossYtd: roundMoney(ytd.gross + money.gross),
        dailyRate: money.dailyRate,
        nonWorkingAmount: money.nonWorkingAmount,
        lopAmount: money.lopAmount,
        net: money.net,
        netInWords: amountInWordsInr(money.net),
        tdsSource,
        tds,
        leave,
        ytd,
        tax,
      };
    },
  };
}
