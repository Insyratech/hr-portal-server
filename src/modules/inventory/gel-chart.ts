/** Agarose gel chart helpers (matches lab Agarose Gel Preparation Chart). */

export type GelComponentKey = 'agarose' | 'buffer' | 'stain';

export type GelComputedLine = {
  componentKey: GelComponentKey;
  name: string;
  quantityValue: number;
  quantityUnit: string;
};

/** Agarose g = (% / 100) × volume mL, rounded to 2 dp (chart values). */
export function agaroseGrams(percent: number, volumeMl: number): number {
  return Math.round((percent / 100) * volumeMl * 100) / 100;
}

export function buildGelLines(input: {
  percent: number;
  volumeMl: number;
  etbrUl: number;
  names: Partial<Record<GelComponentKey, string>>;
}): GelComputedLine[] {
  const agaroseName = input.names.agarose?.trim() || 'Agarose';
  const bufferName = input.names.buffer?.trim() || '1X TAE Buffer';
  const stainName = input.names.stain?.trim() || 'EtBr';
  return [
    {
      componentKey: 'agarose',
      name: agaroseName,
      quantityValue: agaroseGrams(input.percent, input.volumeMl),
      quantityUnit: 'g',
    },
    {
      componentKey: 'buffer',
      name: bufferName,
      quantityValue: input.volumeMl,
      quantityUnit: 'mL',
    },
    {
      componentKey: 'stain',
      name: stainName,
      quantityValue: input.etbrUl,
      quantityUnit: 'µL',
    },
  ];
}

export function formatGelRunLabel(percent: number, volumeMl: number): string {
  const pct = Number.isInteger(percent) ? String(percent) : String(percent);
  return `${pct}% · ${volumeMl} mL`;
}
