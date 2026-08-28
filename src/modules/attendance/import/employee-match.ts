export type MatchableEmployee = {
  id: string;
  employee_code: string;
  full_name: string;
};

export type EmployeeMatchStatus = 'MATCHED' | 'UNMATCHED' | 'NAME_MISMATCH';

export type EmployeeMatchResult = {
  employee: MatchableEmployee | null;
  status: EmployeeMatchStatus;
  warnings: string[];
};

export function normalizeCode(value: string): string {
  return value.trim().toLowerCase();
}

/** Strip common portal/device prefixes before comparing codes. */
export function employeeCodeKeys(value: string): string[] {
  const n = normalizeCode(value);
  const withoutId = n.replace(/^id/, '');
  const withId = n.startsWith('id') ? n : `id${n}`;
  const withoutEmp = withoutId.replace(/^emp[-_]?/, '');
  const digits = n.replace(/\D/g, '');
  return [...new Set([n, withoutId, withId, withoutEmp, digits].filter(Boolean))];
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function namesMatch(fileName: string, fullName: string): boolean {
  const file = fileName.trim().toLowerCase().replace(/\s+/g, ' ');
  const full = fullName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!file || !full) return true;
  if (file === full) return true;
  const fileParts = file.split(' ');
  const fullParts = full.split(' ');
  if (fullParts[0] === fileParts[0]) return true;
  if (fileParts[0] && fullParts.includes(fileParts[0])) return true;
  return fullParts.some((part) => part.length > 2 && file.includes(part));
}

export type EmployeeLookup = {
  byCode: Map<string, MatchableEmployee>;
  bySuffix: Map<string, MatchableEmployee[]>;
  byName: Map<string, MatchableEmployee[]>;
};

export function buildEmployeeLookup(employees: MatchableEmployee[]): EmployeeLookup {
  const byCode = new Map<string, MatchableEmployee>();
  const bySuffix = new Map<string, MatchableEmployee[]>();
  const byName = new Map<string, MatchableEmployee[]>();

  for (const row of employees) {
    for (const key of employeeCodeKeys(row.employee_code)) {
      if (!byCode.has(key)) byCode.set(key, row);
    }

    const empDigits = digitsOnly(row.employee_code);
    if (empDigits) {
      for (let len = 2; len <= empDigits.length; len += 1) {
        const suffix = empDigits.slice(-len);
        const list = bySuffix.get(suffix) ?? [];
        if (!list.some((item) => item.id === row.id)) list.push(row);
        bySuffix.set(suffix, list);
      }
    }

    const full = row.full_name.trim().toLowerCase().replace(/\s+/g, ' ');
    const nameKeys = new Set<string>([full, full.split(' ')[0] ?? ''].filter(Boolean));
    for (const key of nameKeys) {
      const list = byName.get(key) ?? [];
      if (!list.some((item) => item.id === row.id)) list.push(row);
      byName.set(key, list);
    }
  }

  return { byCode, bySuffix, byName };
}

function uniqueMatch(candidates: MatchableEmployee[]): MatchableEmployee | null {
  if (candidates.length === 1) return candidates[0];
  return null;
}

function matchByCode(fileCode: string, lookup: EmployeeLookup): MatchableEmployee | null {
  for (const key of employeeCodeKeys(fileCode)) {
    const hit = lookup.byCode.get(key);
    if (hit) return hit;
  }

  const fileDigits = digitsOnly(fileCode);
  if (!fileDigits) return null;

  for (const row of lookup.byCode.values()) {
    if (digitsOnly(row.employee_code) === fileDigits) return row;
  }

  const suffixHits = lookup.bySuffix.get(fileDigits) ?? [];
  const suffixMatch = uniqueMatch(suffixHits);
  if (suffixMatch) return suffixMatch;

  if (fileDigits.length >= 3) {
    const endsWithHits = [...lookup.byCode.values()].filter((row) => digitsOnly(row.employee_code).endsWith(fileDigits));
    return uniqueMatch(endsWithHits);
  }

  return null;
}

function matchByName(fileName: string, lookup: EmployeeLookup): MatchableEmployee | null {
  const normalized = fileName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return null;

  const exact = lookup.byName.get(normalized) ?? [];
  const exactHit = uniqueMatch(exact);
  if (exactHit) return exactHit;

  const first = normalized.split(' ')[0] ?? '';
  if (!first) return null;
  const firstHits = (lookup.byName.get(first) ?? []).filter((row) => namesMatch(fileName, row.full_name));
  return uniqueMatch(firstHits);
}

export function matchEmployee(
  fileCode: string,
  fileName: string,
  lookup: EmployeeLookup,
): EmployeeMatchResult {
  const warnings: string[] = [];
  let employee = matchByCode(fileCode, lookup);

  if (!employee && fileName.trim()) {
    employee = matchByName(fileName, lookup);
    if (employee) {
      warnings.push(`Matched ${employee.full_name} by name because code “${fileCode}” did not match ${employee.employee_code}.`);
    }
  }

  if (!employee) {
    return { employee: null, status: 'UNMATCHED', warnings };
  }

  if (fileName.trim() && !namesMatch(fileName, employee.full_name)) {
    warnings.push(`File name “${fileName}” does not match ${employee.full_name}.`);
    return { employee, status: 'NAME_MISMATCH', warnings };
  }

  return { employee, status: 'MATCHED', warnings };
}
