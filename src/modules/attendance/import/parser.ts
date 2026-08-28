const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/g;
const AMPM_TIME_RE = /\b(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*(am|pm)\b/gi;
const USER_ID_RE = /user\s*id/i;
const NAME_RE = /^name\b/i;

export type ParsedPunchDay = {
  employeeCode: string;
  name: string;
  day: number;
  times: string[];
};

export type ParseException = {
  employeeCode: string;
  name: string;
  reason: string;
};

export type BiometricParseResult = {
  days: ParsedPunchDay[];
  exceptions: ParseException[];
};

function cellText(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const fractional = value >= 1 ? value % 1 : value;
    if (fractional > 0) {
      const total = Math.round(fractional * 24 * 60);
      const hours = Math.floor(total / 60) % 24;
      const minutes = total % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
  }
  return String(value).trim();
}

export function extractTimes(value: unknown): string[] {
  const text = cellText(value);
  if (!text) return [];

  if (/\b(am|pm)\b/i.test(text)) {
    const ampmTimes: string[] = [];
    AMPM_TIME_RE.lastIndex = 0;
    let ampmMatch: RegExpExecArray | null;
    while ((ampmMatch = AMPM_TIME_RE.exec(text))) {
      let hours = Number(ampmMatch[1]);
      const minutes = ampmMatch[2];
      const meridiem = ampmMatch[3].toLowerCase();
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
      ampmTimes.push(`${String(hours).padStart(2, '0')}:${minutes}`);
    }
    if (ampmTimes.length > 0) return ampmTimes;
  }

  const times: string[] = [];
  TIME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIME_RE.exec(text))) {
    times.push(`${match[1].padStart(2, '0')}:${match[2]}`);
  }
  return times;
}

function afterColon(text: string): string {
  const idx = text.indexOf(':');
  if (idx === -1) return '';
  return text.slice(idx + 1).trim();
}

function isFieldLabel(text: string): boolean {
  const label = (text.split(':')[0] ?? '').trim();
  return USER_ID_RE.test(text) || USER_ID_RE.test(label) || NAME_RE.test(text) || NAME_RE.test(label) || /^dept\.?$/i.test(label);
}

/** Biometric reports often put "UserID:" in one cell and the number two columns over. */
function valueBesideLabel(row: unknown[], labelCol: number): string {
  const inline = afterColon(cellText(row[labelCol]));
  if (inline) return inline;
  for (let c = labelCol + 1; c < row.length; c += 1) {
    const text = cellText(row[c]);
    if (!text) continue;
    if (isFieldLabel(text)) return '';
    return afterColon(text) || text;
  }
  return '';
}

function findUserBlocks(grid: unknown[][]): { row: number; code: string; name: string }[] {
  const blocks: { row: number; code: string; name: string }[] = [];
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c += 1) {
      const text = cellText(row[c]);
      if (!USER_ID_RE.test(text)) continue;
      const code = valueBesideLabel(row, c);
      let name = '';
      for (let n = c; n < row.length; n += 1) {
        const label = cellText(row[n]);
        const nameLabel = (label.split(':')[0] ?? '').trim();
        if (NAME_RE.test(label) || NAME_RE.test(nameLabel)) {
          name = valueBesideLabel(row, n);
          break;
        }
      }
      if (!name) {
        const next = grid[r + 1] ?? [];
        for (let n = 0; n < next.length; n += 1) {
          const label = cellText(next[n]);
          if (NAME_RE.test(label)) {
            name = valueBesideLabel(next, n);
            break;
          }
        }
      }
      if (code) {
        blocks.push({ row: r, code, name });
      } else {
        blocks.push({ row: r, code: '', name });
      }
    }
  }
  return blocks;
}

function findDayHeader(grid: unknown[][], startRow: number, endRow: number): { row: number; columns: Map<number, number> } | null {
  for (let r = startRow; r < endRow; r += 1) {
    const row = grid[r] ?? [];
    const columns = new Map<number, number>();
    for (let c = 0; c < row.length; c += 1) {
      const text = cellText(row[c]);
      if (/^\d{1,2}$/.test(text)) {
        const day = Number(text);
        if (day >= 1 && day <= 31) columns.set(c, day);
      }
    }
    if (columns.size >= 7) {
      return { row: r, columns };
    }
  }
  return null;
}

/**
 * Biometric monthly block: UserID / Name, then a day-number row, then stacked HH:mm
 * (newlines or extra rows). First time = in, last = out.
 */
export function parseBiometricGrid(grid: unknown[][]): BiometricParseResult {
  const blocks = findUserBlocks(grid);
  const days: ParsedPunchDay[] = [];
  const exceptions: ParseException[] = [];
  const seen = new Map<string, number>();

  if (blocks.length === 0) {
    exceptions.push({ employeeCode: '', name: '', reason: 'No UserID blocks found in this workbook.' });
    return { days, exceptions };
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block.code) {
      exceptions.push({ employeeCode: '', name: block.name, reason: 'Missing UserID.' });
      continue;
    }
    const nextStart = blocks[i + 1]?.row ?? grid.length;
    const key = block.code.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const header = findDayHeader(grid, block.row, nextStart);
    if (!header) {
      exceptions.push({ employeeCode: block.code, name: block.name, reason: 'No day grid found for this UserID.' });
      continue;
    }
    const timesByDay = new Map<number, string[]>();
    for (let r = header.row + 1; r < nextStart; r += 1) {
      if (USER_ID_RE.test((grid[r] ?? []).map(cellText).join(' '))) break;
      const row = grid[r] ?? [];
      for (const [col, day] of header.columns) {
        const found = extractTimes(row[col]);
        if (found.length === 0) continue;
        const list = timesByDay.get(day) ?? [];
        list.push(...found);
        timesByDay.set(day, list);
      }
    }
    for (const [day, times] of timesByDay) {
      days.push({ employeeCode: block.code, name: block.name, day, times });
    }
  }

  for (const [key, count] of seen) {
    if (!key || count < 2) continue;
    const sample = blocks.find((b) => b.code.trim().toLowerCase() === key);
    exceptions.push({
      employeeCode: sample?.code ?? key,
      name: sample?.name ?? '',
      reason: 'Duplicate UserID in this file.',
    });
  }

  const duplicateKeys = new Set(
    [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );
  return {
    days: days.filter((row) => !duplicateKeys.has(row.employeeCode.trim().toLowerCase())),
    exceptions,
  };
}

export function firstAndLast(times: string[]): { inTime: string | null; outTime: string | null } {
  if (times.length === 0) return { inTime: null, outTime: null };
  if (times.length === 1) return { inTime: times[0], outTime: null };
  return { inTime: times[0], outTime: times[times.length - 1] };
}
