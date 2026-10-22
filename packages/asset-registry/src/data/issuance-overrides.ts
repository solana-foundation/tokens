/**
 * Curated issuance overrides, keyed `<chain>:<address>` (EVM addresses
 * lowercase). Pure data; consulted by `resolveVariantIssuance` after an
 * explicit `issuance:` tag and before the kind mapping.
 *
 * Use it for deployments whose kind says one thing and whose economics say
 * another: a stablecoin issuer's own mint on one chain and a bridge-wrapped
 * copy of it on another both carry kind `stablecoin`, but only the first is
 * issued supply. `reason` is free text for the reviewer; `coinId` is the
 * CoinGecko coin that evidences it when there is one.
 *
 * Generated entries come from `scripts/generate-issuance-overrides.ts`; keep
 * the list sorted by key so diffs stay reviewable.
 */
import type { VariantIssuance } from '../issuance';

export interface IssuanceOverride {
    issuance: VariantIssuance;
    reason: string;
    coinId?: string;
}

export const ISSUANCE_OVERRIDES: Readonly<Record<string, IssuanceOverride>> = {};
