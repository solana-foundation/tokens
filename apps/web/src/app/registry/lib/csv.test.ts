import { describe, expect, test } from 'bun:test';

import { escapeCsvField, registryCsvFilename, registryRowsToCsv } from './csv';
import type { RegistryRow } from './types';

const baseRow: RegistryRow = {
    symbol: 'USDC',
    mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USD Coin',
    logoURI: null,
    hasTokenPage: true,
    solanaClass: 'Stablecoin',
    rwaClass: 'Fiat-backed',
    alliumClass: null,
    rwaValueUsd: 1234.5,
    alliumValueUsd: null,
    marketCapUsd: 60_000_000_000,
    valueUsd: 1234.5,
};

describe('escapeCsvField', () => {
    test('passes plain values through and blanks nulls', () => {
        expect(escapeCsvField('USDC')).toBe('USDC');
        expect(escapeCsvField(12.5)).toBe('12.5');
        expect(escapeCsvField(null)).toBe('');
        expect(escapeCsvField(undefined)).toBe('');
    });

    test('quotes commas, quotes and newlines', () => {
        expect(escapeCsvField('Wrapped, Inc')).toBe('"Wrapped, Inc"');
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
        expect(escapeCsvField('a\nb')).toBe('"a\nb"');
    });

    test('defuses spreadsheet formula prefixes', () => {
        expect(escapeCsvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
        expect(escapeCsvField('-1')).toBe("'-1");
        expect(escapeCsvField(-1)).toBe('-1');
    });
});

describe('registryRowsToCsv', () => {
    test('emits header + one CRLF-terminated line per row', () => {
        const csv = registryRowsToCsv([baseRow, { ...baseRow, symbol: 'X,Y', name: null, hasTokenPage: false }]);
        const lines = csv.split('\r\n');
        expect(lines.at(-1)).toBe('');
        expect(lines[0]).toBe(
            'symbol,name,mint_address,solana_asset_class,rwa_asset_class,rwa_asset_value_usd,allium_asset_class,allium_asset_value_usd,coingecko_market_cap_usd,value_usd,token_page_url',
        );
        expect(lines[1]).toBe(
            `USDC,USD Coin,${baseRow.mintAddress},Stablecoin,Fiat-backed,1234.5,,,60000000000,1234.5,https://tokens.xyz/token/${baseRow.mintAddress}`,
        );
        expect(lines[2]).toBe(`"X,Y",,${baseRow.mintAddress},Stablecoin,Fiat-backed,1234.5,,,60000000000,1234.5,`);
        expect(lines).toHaveLength(4);
    });

    test('empty input still yields the header', () => {
        const lines = registryRowsToCsv([]).split('\r\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('symbol,');
        expect(lines[1]).toBe('');
    });
});

describe('registryCsvFilename', () => {
    test('uses the registry generation date', () => {
        expect(registryCsvFilename('2026-09-22T10:15:00Z')).toBe('solana-asset-registry-2026-09-22.csv');
    });
    test('falls back when the date is unparseable', () => {
        expect(registryCsvFilename('nope')).toBe('solana-asset-registry-latest.csv');
    });
});
