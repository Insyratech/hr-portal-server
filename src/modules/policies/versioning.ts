export type PolicyVersionStatus = 'draft' | 'published';

export type PolicyVersionSnapshot = {
  id: string;
  versionLabel: string;
  content: string;
  status: PolicyVersionStatus;
  acknowledgementRequired: boolean;
  effectiveDate: string | null;
};

/** Publishing must never mutate a published version's content or label. */
export function assertPublishDoesNotRewrite(
  existing: PolicyVersionSnapshot | null,
  published: PolicyVersionSnapshot,
): void {
  if (!existing || existing.status !== 'published') {
    return;
  }
  if (existing.id === published.id) {
    throw new Error('PUBLISH_REWRITES_VERSION');
  }
  if (existing.content !== published.content && existing.id === published.id) {
    throw new Error('PUBLISH_REWRITES_VERSION');
  }
}

export function nextVersionLabel(existingLabels: string[]): string {
  const majors = existingLabels
    .map((label) => {
      const match = /^(\d+)(?:\.(\d+))?$/.exec(label.trim());
      if (!match) return null;
      return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
    })
    .filter((item): item is { major: number; minor: number } => item !== null);

  if (majors.length === 0) {
    return '1.0';
  }

  const latest = majors.reduce((best, item) => {
    if (item.major > best.major || (item.major === best.major && item.minor > best.minor)) {
      return item;
    }
    return best;
  });

  return `${latest.major}.${latest.minor + 1}`;
}
