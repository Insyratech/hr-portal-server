import { describe, expect, it } from 'vitest';
import { amountInWordsInr } from './amount-in-words';

describe('amountInWordsInr', () => {
  it('handles zero and ones', () => {
    expect(amountInWordsInr(0)).toBe('Zero Rupees Only');
    expect(amountInWordsInr(1)).toBe('One Rupee Only');
  });

  it('uses Indian numbering', () => {
    expect(amountInWordsInr(51_300)).toBe('Fifty One Thousand Three Hundred Rupees Only');
    expect(amountInWordsInr(1_25_000)).toBe('One Lakh Twenty Five Thousand Rupees Only');
  });

  it('includes paise when present', () => {
    expect(amountInWordsInr(100.5)).toBe('One Hundred Rupees and Fifty Paise Only');
  });
});
