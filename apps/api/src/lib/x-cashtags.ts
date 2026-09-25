import { Effect } from 'effect';

import { getVariantByMint } from '@tokens/asset-registry';
import { tapErrorAndDefault } from '@tokens/effect';
import { getProviderTokenMetadataByMints } from './birdeye-search';

/**
 * X's token-tagging feature shows `$SOL` on x.com, but the API `text` (and
 * `entities`) only carry the underlying `chain:address` reference, e.g.
 * `solana:So11111111111111111111111111111111111111112`. Restore those to
 * `$SYMBOL` so tweets read the same way in the feed as they do on X.
 */

export interface XTokenTag {
    /** The exact substring X put in the post text. */
    raw: string;
    chain: string;
    address: string;
}

const SOLANA_CHAIN = 'solana';

// `<chain>:<address>` where address is a base58 Solana mint or a 0x EVM address.
// The lookarounds keep this from matching inside URLs, handles, or `$` cashtags.
const TOKEN_TAG_PATTERN = /(?<![\w$@#/:])([a-z][a-z0-9-]{1,31}):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?![\w/])/g;

export function findXTokenTags(text: string): XTokenTag[] {
    const tags: XTokenTag[] = [];
    for (const match of text.matchAll(TOKEN_TAG_PATTERN)) {
        const [raw, chain, address] = match;
        if (!raw || !chain || !address) continue;
        tags.push({ raw, chain: chain.toLowerCase(), address });
    }
    return tags;
}

function normalizeSymbol(value: string | null | undefined): string | null {
    const symbol = (value ?? '').trim().replace(/^\$+/, '');
    if (!symbol || /\s/.test(symbol) || symbol.length > 24) return null;
    return symbol;
}

/** When nothing can name the token, show a cashtag-shaped short address instead of the raw tag. */
export function shortenTokenAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function restoreXCashtags(text: string, symbolByAddress: ReadonlyMap<string, string>): string {
    return text.replace(TOKEN_TAG_PATTERN, (_raw, _chain: string, address: string) => {
        const symbol = symbolByAddress.get(address);
        return `$${symbol ?? shortenTokenAddress(address)}`;
    });
}

function resolveFromRegistry(address: string): string | null {
    const match = getVariantByMint(address);
    if (!match) return null;
    // Prefer the canonical asset symbol: the wrapped-SOL variant is `wSOL` but X tags it as `$SOL`.
    return normalizeSymbol(match.asset.symbol) ?? normalizeSymbol(match.variant.symbol);
}

/**
 * Resolve tag addresses to symbols: the static registry first (no network),
 * then Birdeye for any Solana mint the registry doesn't know. Never fails;
 * unresolved addresses are simply absent from the result.
 */
export function resolveXCashtagSymbols(tags: readonly XTokenTag[]): Effect.Effect<Map<string, string>, never> {
    return Effect.gen(function* () {
        const symbolByAddress = new Map<string, string>();
        const unresolvedSolanaMints = new Set<string>();

        for (const tag of tags) {
            if (symbolByAddress.has(tag.address)) continue;
            if (tag.chain !== SOLANA_CHAIN) continue;
            const symbol = resolveFromRegistry(tag.address);
            if (symbol) symbolByAddress.set(tag.address, symbol);
            else unresolvedSolanaMints.add(tag.address);
        }

        if (unresolvedSolanaMints.size > 0) {
            const metadata = yield* getProviderTokenMetadataByMints([...unresolvedSolanaMints]).pipe(
                tapErrorAndDefault('x.cashtags.birdeye', [], { mints: [...unresolvedSolanaMints] }),
            );
            for (const item of metadata) {
                const symbol = normalizeSymbol(item.symbol);
                if (symbol && unresolvedSolanaMints.has(item.address)) symbolByAddress.set(item.address, symbol);
            }
        }

        return symbolByAddress;
    });
}

/** Restore `$SYMBOL` cashtags across a batch of post texts with a single resolution pass. */
export function restoreXCashtagsInTexts(texts: readonly string[]): Effect.Effect<string[], never> {
    const tags = texts.flatMap(findXTokenTags);
    if (tags.length === 0) return Effect.succeed([...texts]);

    return resolveXCashtagSymbols(tags).pipe(
        Effect.map(symbolByAddress => texts.map(text => restoreXCashtags(text, symbolByAddress))),
    );
}
