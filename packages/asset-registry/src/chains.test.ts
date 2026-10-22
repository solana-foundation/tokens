import { describe, expect, test } from 'bun:test';

import {
    CHAINS,
    CHAIN_KINDS,
    EVM_CHAIN_KINDS,
    EVM_NATIVE_ASSET_ADDRESS,
    birdeyeChains,
    chainAddressKey,
    chainsSupporting,
    inferAddressFamily,
    isChainKind,
    normalizeAddressForChain,
    normalizeAddressForLookup,
    parseChainAddressKey,
    variantKeyFor,
} from './chains';
import { AGGREGATE_COIN_IDS, NATIVE_COIN_DEPLOYMENTS } from './data/chain-deployments';
import { CANONICAL_ASSETS } from './data';

const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('CHAINS', () => {
    test('every chain id has a complete public entry', () => {
        for (const chain of CHAIN_KINDS) {
            const config = CHAINS[chain];
            expect(config.id).toBe(chain);
            expect(config.caip2).toMatch(/^(solana|eip155):/);
            expect(config.label.length).toBeGreaterThan(0);
            expect(config.explorer.tokenUrl('abc')).toContain('abc');
            expect(config.providers.coingeckoPlatform.length).toBeGreaterThan(0);
        }
    });

    test('EVM chains carry their numeric chain id and a Birdeye slug', () => {
        for (const chain of EVM_CHAIN_KINDS) {
            expect(CHAINS[chain].family).toBe('evm');
            expect(CHAINS[chain].evmChainId).toBeGreaterThan(0);
            expect(CHAINS[chain].caip2).toBe(`eip155:${CHAINS[chain].evmChainId}`);
            expect(CHAINS[chain].providers.birdeyeChain).toBeDefined();
        }
        expect(CHAINS.solana.family).toBe('svm');
        expect(CHAINS.solana.evmChainId).toBeUndefined();
        expect(birdeyeChains()).toEqual([...CHAIN_KINDS]);
    });

    test('chain ids are shape-safe for the DB CHECK and never contain a colon', () => {
        for (const chain of CHAIN_KINDS) expect(chain).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
    });

    test('capability gates are explicit per chain', () => {
        expect(chainsSupporting('markets')).toEqual([...CHAIN_KINDS]);
        expect(chainsSupporting('swap')).toEqual(['solana']);
        expect(chainsSupporting('executionQuality')).toEqual(['solana']);
    });
});

describe('address normalization', () => {
    test('base58 is Solana, 0x is EVM, anything else is unknown', () => {
        expect(inferAddressFamily(USDC_SOLANA)).toBe('svm');
        expect(inferAddressFamily(USDC_BASE_CHECKSUMMED)).toBe('evm');
        expect(inferAddressFamily('not-an-address')).toBeNull();
        expect(inferAddressFamily('0x1234')).toBeNull();
    });

    test('EVM addresses are lowercased; Solana addresses are kept as-is', () => {
        expect(normalizeAddressForChain('base', USDC_BASE_CHECKSUMMED)).toBe(USDC_BASE_CHECKSUMMED.toLowerCase());
        expect(normalizeAddressForChain('solana', ` ${USDC_SOLANA} `)).toBe(USDC_SOLANA);
        expect(normalizeAddressForLookup(USDC_BASE_CHECKSUMMED)).toBe(USDC_BASE_CHECKSUMMED.toLowerCase());
        expect(normalizeAddressForLookup(USDC_SOLANA)).toBe(USDC_SOLANA);
    });

    test('cross-family addresses are rejected for the chain', () => {
        expect(normalizeAddressForChain('ethereum', USDC_SOLANA)).toBeNull();
        expect(normalizeAddressForChain('solana', USDC_BASE_CHECKSUMMED)).toBeNull();
        expect(normalizeAddressForChain('polygon', '0x00')).toBeNull();
    });
});

describe('chain:address keys', () => {
    test('round-trip through parseChainAddressKey with normalization', () => {
        expect(parseChainAddressKey(`base:${USDC_BASE_CHECKSUMMED}`)).toEqual({
            chain: 'base',
            address: USDC_BASE_CHECKSUMMED.toLowerCase(),
        });
        expect(parseChainAddressKey(`solana:${USDC_SOLANA}`)).toEqual({ chain: 'solana', address: USDC_SOLANA });
        expect(variantKeyFor('solana', USDC_SOLANA)).toBe(chainAddressKey('solana', USDC_SOLANA));
    });

    test('rejects unknown chains, the legacy dash form, and bad addresses', () => {
        expect(parseChainAddressKey(`polygon-pos:${USDC_BASE_CHECKSUMMED}`)).toBeNull();
        expect(parseChainAddressKey(`solana-${USDC_SOLANA}`)).toBeNull();
        expect(parseChainAddressKey(`ethereum:${USDC_SOLANA}`)).toBeNull();
        expect(parseChainAddressKey(USDC_SOLANA)).toBeNull();
        expect(isChainKind('polygon-pos')).toBe(false);
    });
});

describe('chain deployment data', () => {
    test('native deployments use normalized addresses on known chains', () => {
        for (const rows of Object.values(NATIVE_COIN_DEPLOYMENTS)) {
            for (const row of rows) {
                expect(isChainKind(row.chain)).toBe(true);
                expect(normalizeAddressForChain(row.chain, row.address)).toBe(row.address);
                if (row.kind === 'native') expect(row.address).toBe(EVM_NATIVE_ASSET_ADDRESS);
            }
        }
    });

    test('every asset with native deployments or aggregate coin ids exists in the registry', () => {
        const ids = new Set(CANONICAL_ASSETS.map(asset => asset.assetId));
        for (const assetId of Object.keys(NATIVE_COIN_DEPLOYMENTS)) expect(ids.has(assetId)).toBe(true);
        for (const assetId of Object.keys(AGGREGATE_COIN_IDS)) expect(ids.has(assetId)).toBe(true);
    });
});
