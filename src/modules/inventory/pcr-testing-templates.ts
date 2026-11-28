/**
 * SOP “Standard Reaction mixture (per tube)” templates for PCR Testing types.
 * Left-column (W.P.M) rows from lab cards; volumes are per 1X / per tube.
 * Master mix stock still comes from the separate 9 master-mix recipes — these
 * rows are logged mixture only (except the MM volume used for Nx × deduct).
 */

export type InventoryPcrTestingComponentTemplate = {
  name: string;
  quantityValue: number;
  quantityUnit: 'ul';
};

export type InventoryPcrTestingType = {
  id: string;
  name: string;
  totalVolumeValue: number;
  totalVolumeUnit: 'ul';
  components: InventoryPcrTestingComponentTemplate[];
};

export const PCR_TESTING_TYPES: readonly InventoryPcrTestingType[] = [
  {
    id: 'a1-pcr',
    name: 'A1-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M + NFW', quantityValue: 7, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 3, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a2-pcr',
    name: 'A2-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M+NFW', quantityValue: 7, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 3, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a3-pcr',
    name: 'A3-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M+NFW', quantityValue: 8.5, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 1.5, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a4-pcr',
    name: 'A4-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M+NFW', quantityValue: 7, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 3, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a6-pcr',
    name: 'A6-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M', quantityValue: 8, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 2, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a7-clopidogrel-q-pcr',
    name: 'A7 - Clopidogrel q-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'HRM Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M', quantityValue: 2.6, quantityUnit: 'ul' },
      { name: 'NFW', quantityValue: 5.4, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 2, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a8-tpmt-q-pcr',
    name: 'A8- TPMT q-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'HRM Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M', quantityValue: 2, quantityUnit: 'ul' },
      { name: 'NFW', quantityValue: 6, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 2, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a8-tpmt-pcr',
    name: 'A8 TPMT-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M', quantityValue: 0.5, quantityUnit: 'ul' },
      { name: 'NFW', quantityValue: 8, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 1.5, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a9-dpyd-pcr',
    name: 'A-9 DPYD PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M', quantityValue: 0.5, quantityUnit: 'ul' },
      { name: 'NFW', quantityValue: 7.5, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 2, quantityUnit: 'ul' },
    ],
  },
  {
    id: 'a9-dpyd-q-pcr',
    name: 'A9 - DPYD q-PCR',
    totalVolumeValue: 20,
    totalVolumeUnit: 'ul',
    components: [
      { name: 'HRM Master Mix', quantityValue: 10, quantityUnit: 'ul' },
      { name: 'W.P.M', quantityValue: 2.5, quantityUnit: 'ul' },
      { name: 'NFW', quantityValue: 4.5, quantityUnit: 'ul' },
      { name: 'Template', quantityValue: 3, quantityUnit: 'ul' },
    ],
  },
] as const;

export function findPcrTestingType(id: string): InventoryPcrTestingType | null {
  const key = id.trim();
  if (!key) return null;
  return PCR_TESTING_TYPES.find((row) => row.id === key) ?? null;
}

/** True when a mixture row is the SOP master-mix line (drives MM volume default). */
export function isPcrMasterMixComponentName(name: string): boolean {
  return /master\s*mix/i.test(name.trim());
}
