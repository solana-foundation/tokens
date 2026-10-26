/**
 * Read side of `asset_risk_latest` (+ the raw Webacy payload tables the same
 * cron writes). Until now nothing served these rows to the API: holder
 * concentration, mint time, LP lock and the authority flags were collected
 * for curated mints and never read. The judged-search family consumes them
 * through `assetRiskGetLatestByMints`.
 *
 * Coverage is whatever `refreshCuratedAssetRisk` has visited: curated /
 * registry mints only. A mint without a row answers `risk: null`, which the
 * caller treats as "unknown", never as "safe".
 */

import { InvalidArgsError } from './assets';

export interface AssetRiskRow {
    mint: string;
    asset_id: string;
    ok: boolean;
    tags: unknown;
    lp_locked_percent: number | null;
    top_10_holders_percent: number | null;
    holder_count: number | null;
    token_mint_time: string | null;
    risk_score_10: number | null;
    safety_score_10: number | null;
    last_fetched_at: number;
    /** `webacy_token_latest.payload_json` → `token_risk` object, extracted in SQL. */
    token_risk: unknown;
    /** `webacy_token_latest.payload_json` → `token_info` object. */
    token_info: unknown;
    /** `webacy_token_latest.payload_json` → `buy_sell_taxes` object (sibling of token_risk under risk.details). */
    buy_sell_taxes: unknown;
    /** `webacy_trading_lite_latest.payload_json` (holder/sniper/bundler figures). */
    trading_lite: unknown;
}

export interface AssetRiskReadsRepo {
    findLatestByMints(mints: readonly string[]): Promise<AssetRiskRow[]>;
}

/** Authority / launch-hygiene flags, `null` = unknown (never "no"). */
export interface AssetSecurityDoc {
    mintable: boolean | null;
    freezable: boolean | null;
    mutableMetadata: boolean | null;
    renounced: boolean | null;
    transferTax: boolean | null;
    devHoldingPercent: number | null;
    sniperHoldingPercent: number | null;
    bundlerHoldingPercent: number | null;
}

export interface AssetRiskDoc {
    mint: string;
    assetId: string;
    top10HoldersPercent: number | null;
    holderCount: number | null;
    /** ISO string when known. */
    tokenMintTime: string | null;
    lpLockedPercent: number | null;
    riskScore10: number | null;
    safetyScore10: number | null;
    /** Webacy tag keys (e.g. `is_mintable`), flattened from the stored objects. */
    tags: string[];
    security: AssetSecurityDoc | null;
    lastFetchedAt: number;
}

export interface GetLatestByMintsEntry {
    mint: string;
    risk: AssetRiskDoc | null;
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

function percent(value: unknown): number | null {
    // Webacy reports percentages as numbers (0–100) or numeric strings.
    const n = typeof value === 'string' ? Number(value) : value;
    const f = finite(n);
    return f === null ? null : Math.max(0, Math.min(100, f));
}

/** Stored tags are `{ key, name, type, severity, description }` objects; keep the key. */
function tagKeys(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const keys: string[] = [];
    for (const item of value) {
        if (typeof item === 'string') keys.push(item);
        else if (item && typeof item === 'object') {
            const key = (item as { key?: unknown; name?: unknown }).key ?? (item as { name?: unknown }).name;
            if (typeof key === 'string' && key) keys.push(key);
        }
    }
    return keys;
}

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }
    return typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function securityFromPayloads(
    tokenRisk: unknown,
    tokenInfo: unknown,
    tradingLite: unknown,
    buySellTaxes: unknown = null,
): AssetSecurityDoc | null {
    const risk = asObject(tokenRisk);
    const info = asObject(tokenInfo);
    const trading = asObject(tradingLite);
    // `buy_sell_taxes` is a sibling of token_risk under risk.details; older
    // payloads nested it inside token_risk.
    const taxes = asObject(buySellTaxes) ?? asObject(risk?.buy_sell_taxes ?? info?.buy_sell_taxes);
    if (!risk && !info && !trading && !taxes) return null;

    const transferTax =
        taxes === null
            ? null
            : bool(taxes.has_buy_tax) === true ||
              bool(taxes.has_sell_tax) === true ||
              (finite(taxes.buy_tax) ?? 0) > 0 ||
              (finite(taxes.sell_tax) ?? 0) > 0 ||
              (finite(taxes.transfer_tax) ?? 0) > 0;

    return {
        mintable: bool(risk?.is_mintable) ?? bool(trading?.mintable),
        freezable: bool(risk?.freezeable) ?? bool(trading?.freezable),
        mutableMetadata:
            bool(risk?.['mutable-metadata']) ??
            (info?.is_metadata_immutable === undefined ? null : !bool(info.is_metadata_immutable)),
        renounced: bool(risk?.renounced),
        transferTax,
        devHoldingPercent: percent(trading?.DevHoldingPercentage),
        sniperHoldingPercent: percent(trading?.SniperPercentageHolding),
        bundlerHoldingPercent: percent(trading?.BundlerPercentageHolding),
    };
}

function rowToDoc(row: AssetRiskRow): AssetRiskDoc | null {
    if (!row.ok) return null;
    const mintTime = row.token_mint_time ? Date.parse(row.token_mint_time) : Number.NaN;
    return {
        mint: row.mint,
        assetId: row.asset_id,
        top10HoldersPercent: percent(row.top_10_holders_percent),
        holderCount: finite(row.holder_count),
        tokenMintTime: Number.isFinite(mintTime) ? new Date(mintTime).toISOString() : null,
        lpLockedPercent: percent(row.lp_locked_percent),
        riskScore10: finite(row.risk_score_10),
        safetyScore10: finite(row.safety_score_10),
        tags: tagKeys(row.tags),
        security: securityFromPayloads(row.token_risk, row.token_info, row.trading_lite, row.buy_sell_taxes),
        lastFetchedAt: row.last_fetched_at,
    };
}

export async function getLatestByMints(repo: AssetRiskReadsRepo, args: unknown): Promise<GetLatestByMintsEntry[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { mints?: unknown };
    if (!Array.isArray(a.mints)) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    for (const item of a.mints) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('mints must be an array of strings');
        }
    }
    const mints = (a.mints as string[])
        .slice(0, 250)
        .map(m => m.trim())
        .filter(Boolean);
    if (mints.length === 0) return [];

    const rows = await repo.findLatestByMints(mints);
    // Several assets can share a mint row historically; the freshest wins.
    const byMint = new Map<string, AssetRiskRow>();
    for (const row of rows) {
        const existing = byMint.get(row.mint);
        if (!existing || row.last_fetched_at > existing.last_fetched_at) byMint.set(row.mint, row);
    }
    return mints.map(mint => {
        const row = byMint.get(mint);
        return { mint, risk: row ? rowToDoc(row) : null };
    });
}
