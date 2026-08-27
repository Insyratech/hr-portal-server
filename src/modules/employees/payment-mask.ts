export function maskSecret(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= 4) {
    return '••••';
  }
  return `••••${trimmed.slice(-4)}`;
}

export function maskPayment(input: {
  pan?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  ifsc?: string | null;
}): {
  pan: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  ifsc: string | null;
} {
  return {
    pan: maskSecret(input.pan),
    bankAccountNumber: maskSecret(input.bankAccountNumber),
    bankName: input.bankName?.trim() ? '••••' : null,
    ifsc: maskSecret(input.ifsc),
  };
}
