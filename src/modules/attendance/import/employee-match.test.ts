import { describe, expect, it } from 'vitest';
import { buildEmployeeLookup, employeeCodeKeys, matchEmployee } from './employee-match';

const employees = [
  { id: '1', employee_code: 'ID2025009', full_name: 'Sandip Kumar Yadav' },
  { id: '2', employee_code: '20250014', full_name: 'shivam shekhar' },
  { id: '3', employee_code: 'ID20250018', full_name: 'Vengalaraju Naveen Kumar' },
  { id: '4', employee_code: '20260018', full_name: 'Dheetan Parth Sarthi' },
];

describe('employeeCodeKeys', () => {
  it('normalizes ID prefix variants', () => {
    expect(employeeCodeKeys('ID2025009')).toEqual(expect.arrayContaining(['id2025009', '2025009']));
    expect(employeeCodeKeys('2025009')).toEqual(expect.arrayContaining(['2025009', 'id2025009']));
  });
});

describe('matchEmployee', () => {
  const lookup = buildEmployeeLookup(employees);

  it('matches device code to portal ID prefix code', () => {
    const result = matchEmployee('2025009', 'sandip', lookup);
    expect(result.status).toBe('MATCHED');
    expect(result.employee?.id).toBe('1');
  });

  it('matches short device code to portal code by numeric suffix', () => {
    const result = matchEmployee('14', '', lookup);
    expect(result.status).toBe('MATCHED');
    expect(result.employee?.id).toBe('2');
  });

  it('matches by first name when code is missing', () => {
    const result = matchEmployee('999999', 'sandip', lookup);
    expect(result.status).toBe('MATCHED');
    expect(result.employee?.id).toBe('1');
  });

  it('returns unmatched when code and name are unknown', () => {
    const result = matchEmployee('999999', 'unknown person', lookup);
    expect(result.status).toBe('UNMATCHED');
    expect(result.employee).toBeNull();
  });
});
