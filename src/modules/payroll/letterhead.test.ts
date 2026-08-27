import { describe, expect, it } from 'vitest';
import { letterheadFromCompany } from './letterhead';

describe('letterheadFromCompany', () => {
  it('keeps the frozen slip header after the live company is renamed', () => {
    const company = { name: 'Insyra', address: 'Pune', logoStoragePath: 'logos/insyra.png' };
    const frozen = letterheadFromCompany(company);
    company.name = 'Renamed Ltd';
    company.address = 'Mumbai';
    company.logoStoragePath = 'logos/new.png';
    expect(frozen).toEqual({
      companyName: 'Insyra',
      companyAddress: 'Pune',
      companyLogoPath: 'logos/insyra.png',
    });
  });
});
