import { describe, expect, it } from 'vitest';
import { assertPublishDoesNotRewrite, nextVersionLabel } from './versioning';

describe('HR policy versioning', () => {
  it('does not allow publishing to rewrite an existing published version id', () => {
    const published = {
      id: 'v1',
      versionLabel: '2.1',
      content: 'original',
      status: 'published' as const,
      acknowledgementRequired: true,
      effectiveDate: '2026-08-01',
    };
    expect(() => assertPublishDoesNotRewrite(published, { ...published, content: 'changed' })).toThrow(
      'PUBLISH_REWRITES_VERSION',
    );
    expect(() =>
      assertPublishDoesNotRewrite(published, {
        ...published,
        id: 'v2',
        versionLabel: '2.2',
        content: 'changed',
      }),
    ).not.toThrow();
  });

  it('increments version labels', () => {
    expect(nextVersionLabel([])).toBe('1.0');
    expect(nextVersionLabel(['1.0', '2.1'])).toBe('2.2');
  });
});
