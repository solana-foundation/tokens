import { describe, expect, it } from 'bun:test';

import { buildAttestations, claimCredibilityScore, normalizeClaim } from './claims';
import { NOW_MS, lowLiqDogToken, realUsdc } from './fixtures';

describe('normalizeClaim', () => {
    it('uppercases and trims plain claims', () => {
        expect(normalizeClaim('  usdc ')).toEqual({ normalized: 'USDC', hadSuspiciousCharacters: false });
    });

    it('strips zero-width characters and flags them', () => {
        const result = normalizeClaim('USD​C');
        expect(result.normalized).toBe('USDC');
        expect(result.hadSuspiciousCharacters).toBe(true);
    });

    it('maps Cyrillic confusables to Latin and flags them', () => {
        const result = normalizeClaim('USDС'); // Cyrillic ES
        expect(result.normalized).toBe('USDC');
        expect(result.hadSuspiciousCharacters).toBe(true);
    });

    it('maps Greek confusables to Latin', () => {
        const result = normalizeClaim('SΟL'); // Greek Omicron
        expect(result.normalized).toBe('SOL');
        expect(result.hadSuspiciousCharacters).toBe(true);
    });

    it('normalizes fullwidth compatibility forms via NFKC', () => {
        const result = normalizeClaim('ＵＳＤＣ');
        expect(result.normalized).toBe('USDC');
        expect(result.hadSuspiciousCharacters).toBe(true);
    });

    it('handles empty input', () => {
        expect(normalizeClaim(null)).toEqual({ normalized: '', hadSuspiciousCharacters: false });
        expect(normalizeClaim('   ')).toEqual({ normalized: '', hadSuspiciousCharacters: false });
    });
});

describe('attestations', () => {
    it('gives a curated, deep, old token the full attestation set', () => {
        const attestations = buildAttestations(realUsdc(), NOW_MS);
        const codes = attestations.map(a => a.code);
        expect(codes).toContain('curated_list');
        expect(codes).toContain('registry_variant');
        expect(codes).toContain('deep_liquidity');
        expect(codes).toContain('sustained_activity');
        expect(codes).toContain('established_age');
        expect(codes).toContain('broad_holder_base');
        expect(claimCredibilityScore(attestations)).toBe(100);
    });

    it('gives a dust token no attestations', () => {
        const attestations = buildAttestations(lowLiqDogToken(), NOW_MS);
        expect(attestations).toEqual([]);
        expect(claimCredibilityScore(attestations)).toBe(0);
    });
});
