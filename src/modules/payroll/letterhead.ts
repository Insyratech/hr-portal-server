export function letterheadFromCompany(company: {
  name: string;
  address: string;
  logoStoragePath: string | null;
}): { companyName: string; companyAddress: string; companyLogoPath: string | null } {
  return {
    companyName: company.name,
    companyAddress: company.address,
    companyLogoPath: company.logoStoragePath,
  };
}
