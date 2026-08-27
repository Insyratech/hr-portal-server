export type CompanyRecord = {
  id: string;
  name: string;
  address: string;
  logoStoragePath: string | null;
  logoUrl: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
};

export type CompanyLogoUpload = {
  path: string;
  token: string;
  uploadUrl: string;
};
