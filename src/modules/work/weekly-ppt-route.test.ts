import { describe, expect, it } from 'vitest';
import { WEEKLY_PPT_DIRECT_TO_GM_NOTE } from './weekly-ppt-route';

describe('weekly PPT direct-to-GM routing', () => {
  it('uses a stable note marker for the per-week GM inbox package', () => {
    expect(WEEKLY_PPT_DIRECT_TO_GM_NOTE).toBe('direct_to_gm');
  });
});
