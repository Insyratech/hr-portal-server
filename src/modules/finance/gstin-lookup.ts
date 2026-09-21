import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../config/env';
import {
  composeBillingAddress,
  finalizeGstinLookupMessage,
  mergeGstinLookup,
  parseGstin,
  type GstinLookupResult,
  type GstinLookupSource,
} from './gstin-utils';

const ORG_ID = '00000000-0000-4000-8000-000000000020';

type AddressParts = {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  billingAddress: string | null;
};

function trimOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mapTaxpayerType(raw: unknown): GstinLookupResult['registrationType'] {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (value.includes('compos')) return 'composition';
  if (value.includes('unreg')) return 'unregistered';
  if (value.includes('regular') || value.includes('normal')) return 'regular';
  return 'regular';
}

function splitAddressText(text: string | null): AddressParts {
  if (!text?.trim()) {
    return {
      addressLine1: null,
      addressLine2: null,
      city: null,
      postalCode: null,
      billingAddress: null,
    };
  }
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const postalMatch = normalized.match(/\b(\d{6})\b/);
  const postalCode = postalMatch?.[1] ?? null;
  const lines = normalized
    .split(/\n|,/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\b\d{6}\b/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return {
    addressLine1: lines[0] ?? null,
    addressLine2: lines[1] ?? null,
    city: lines[2] ?? null,
    postalCode,
    billingAddress: normalized,
  };
}

function addressFromParts(input: {
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
  postalCode?: unknown;
  stateName?: unknown;
  fallbackText?: unknown;
}): AddressParts {
  const addressLine1 = trimOrNull(input.line1);
  const addressLine2 = trimOrNull(input.line2);
  const city = trimOrNull(input.city);
  const postalCode = trimOrNull(input.postalCode);
  if (addressLine1 || city || postalCode) {
    return {
      addressLine1,
      addressLine2,
      city,
      postalCode,
      billingAddress: composeBillingAddress({
        addressLine1,
        addressLine2,
        city,
        stateName: trimOrNull(input.stateName),
        postalCode,
      }),
    };
  }
  return splitAddressText(trimOrNull(input.fallbackText));
}

function patchFromRow(
  row: Record<string, unknown>,
  source: GstinLookupSource,
  options?: { includeAddress?: boolean; includeIdentity?: boolean },
): Partial<GstinLookupResult> {
  const includeAddress = options?.includeAddress !== false;
  const includeIdentity = options?.includeIdentity !== false;
  const patch: Partial<GstinLookupResult> = { source };
  if (includeIdentity) {
    patch.legalName =
      trimOrNull(row.legal_name) ||
      trimOrNull(row.company_name) ||
      trimOrNull(row.display_name) ||
      null;
    patch.tradeName = trimOrNull(row.trade_name);
    patch.cin = trimOrNull(row.cin);
    patch.pan = trimOrNull(row.pan);
    const reg = trimOrNull(row.registration_type) as GstinLookupResult['registrationType'];
    if (reg === 'regular' || reg === 'composition' || reg === 'unregistered') {
      patch.registrationType = reg;
    }
  }
  if (includeAddress) {
    const address = addressFromParts({
      line1: row.address_line1 ?? row.billing_line1 ?? row.line1,
      line2: row.address_line2 ?? row.billing_line2 ?? row.line2,
      city: row.city ?? row.billing_city,
      postalCode: row.postal_code ?? row.billing_postal_code,
      stateName: row.state_name,
      fallbackText: row.billing_address ?? row.registered_address,
    });
    Object.assign(patch, address);
    if (trimOrNull(row.state_code)) patch.stateCode = trimOrNull(row.state_code);
    if (trimOrNull(row.state_name)) patch.stateName = trimOrNull(row.state_name);
  }
  return patch;
}

/**
 * Optional live GST network enrichment via gstinapi.in.
 * Requires FINANCE_GSTIN_LOOKUP_API_KEY. Failures are swallowed so lookup never breaks.
 */
export async function fetchGstNetworkProfile(
  gstin: string,
  env: Env,
): Promise<Partial<GstinLookupResult> | null> {
  const apiKey = env.FINANCE_GSTIN_LOOKUP_API_KEY?.trim();
  if (!apiKey) return null;
  const base = (env.FINANCE_GSTIN_LOOKUP_API_URL || 'https://www.gstinapi.in').replace(/\/$/, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(`${base}/v1/gstin/${encodeURIComponent(gstin)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.success === false) return null;
    const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
    const details = (data.address_details as Record<string, unknown> | undefined) ?? {};
    const building = [trimOrNull(details.building_number), trimOrNull(details.building_name)]
      .filter(Boolean)
      .join(', ');
    const street = [trimOrNull(details.floor), trimOrNull(details.street), trimOrNull(details.locality)]
      .filter(Boolean)
      .join(', ');
    const addressLine1 =
      trimOrNull(building) ||
      trimOrNull(data.address)?.split(',')[0]?.trim() ||
      null;
    const addressLine2 =
      trimOrNull(street) ||
      (trimOrNull(data.address)
        ? trimOrNull(data.address)!
            .split(',')
            .slice(1, 3)
            .map((part) => part.trim())
            .filter(Boolean)
            .join(', ') || null
        : null);
    const city =
      trimOrNull(details.city) ||
      trimOrNull(details.district) ||
      trimOrNull(data.city) ||
      null;
    const postalCode = trimOrNull(details.pincode) || trimOrNull(data.pincode);
    const legalName = trimOrNull(data.legal_name);
    const tradeName = trimOrNull(data.trade_name);
    return {
      source: 'gst_network',
      legalName,
      tradeName,
      addressLine1,
      addressLine2,
      city,
      postalCode,
      billingAddress: composeBillingAddress({
        addressLine1,
        addressLine2,
        city,
        stateName: trimOrNull(data.state) || null,
        postalCode,
      }) || trimOrNull(data.address),
      registrationType: mapTaxpayerType(data.taxpayer_type),
    };
  } catch {
    return null;
  }
}

/**
 * Enrich a parsed GSTIN using org/vendor/customer masters, then optional GST network API.
 * Never throws for enrichment misses — always returns at least the parse result.
 */
export async function enrichGstinLookup(
  supabase: SupabaseClient,
  env: Env,
  rawGstin: string,
): Promise<GstinLookupResult> {
  const parsed = parseGstin(rawGstin);
  if (!parsed.validFormat || !parsed.pan) {
    return finalizeGstinLookupMessage(parsed);
  }

  let result = parsed;

  const { data: gstProfile } = await supabase
    .from('finance_org_gst_profiles')
    .select('*')
    .eq('organization_id', ORG_ID)
    .ilike('gstin', parsed.gstin)
    .limit(1)
    .maybeSingle();
  if (gstProfile) {
    result = mergeGstinLookup(result, patchFromRow(gstProfile as Record<string, unknown>, 'gst_profile'));
  }

  const { data: orgExact } = await supabase
    .from('finance_organizations')
    .select('*')
    .eq('id', ORG_ID)
    .maybeSingle();
  if (orgExact) {
    const org = orgExact as Record<string, unknown>;
    const orgGstin = trimOrNull(org.gstin);
    const orgPan = trimOrNull(org.pan);
    if (orgGstin && orgGstin.toUpperCase() === parsed.gstin) {
      result = mergeGstinLookup(result, patchFromRow(org, 'org_master'));
    } else if (orgPan && orgPan.toUpperCase() === parsed.pan) {
      // Same legal entity, possibly another state GSTIN — reuse identity/CIN, not address.
      result = mergeGstinLookup(
        result,
        patchFromRow(org, 'org_master', { includeAddress: false, includeIdentity: true }),
      );
    }
  }

  if (!result.legalName || !result.addressLine1) {
    const { data: vendor } = await supabase
      .from('finance_vendors')
      .select('*')
      .ilike('gstin', parsed.gstin)
      .limit(1)
      .maybeSingle();
    if (vendor) {
      result = mergeGstinLookup(result, patchFromRow(vendor as Record<string, unknown>, 'vendor_master'));
    }
  }

  if (!result.legalName || !result.addressLine1) {
    const { data: customer } = await supabase
      .from('finance_customers')
      .select('*')
      .ilike('gstin', parsed.gstin)
      .limit(1)
      .maybeSingle();
    if (customer) {
      const row = customer as Record<string, unknown>;
      const address = addressFromParts({
        line1: row.billing_line1,
        line2: row.billing_line2,
        city: row.billing_city,
        postalCode: row.billing_postal_code,
        stateName: row.state_name,
        fallbackText: row.billing_address,
      });
      result = mergeGstinLookup(result, {
        source: 'customer_master',
        legalName: trimOrNull(row.company_name) || trimOrNull(row.display_name),
        tradeName: trimOrNull(row.company_name),
        ...address,
        shippingAddress:
          addressFromParts({
            line1: row.shipping_line1,
            line2: row.shipping_line2,
            city: row.shipping_city,
            postalCode: row.shipping_postal_code,
            stateName: row.shipping_state_name ?? row.state_name,
            fallbackText: row.shipping_address,
          }).billingAddress || address.billingAddress,
      });
    }
  }

  // Live network fills gaps (name/address). CIN is not on GST portal — keep master CIN.
  if (!result.legalName || !result.addressLine1 || !result.tradeName) {
    const network = await fetchGstNetworkProfile(parsed.gstin, env);
    if (network) {
      result = mergeGstinLookup(result, network);
    }
  }

  return finalizeGstinLookupMessage(result);
}
