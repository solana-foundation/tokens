import postgres, { type Sql } from 'postgres';
import { onPostgresNotice } from '@tokens/cloudrun-shutdown/postgres-notice';

import type { CoingeckoPriceRow, PricesRepo } from './handlers/prices';

let cached: Sql | null = null;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

export function getSql(): Sql {
    if (cached) return cached;
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL must be set');
    cached = postgres(url, {
        max: envNumber('PG_POOL_MAX', 10),
        idle_timeout: envNumber('PG_IDLE_TIMEOUT', 240),
        connect_timeout: envNumber('PG_CONNECT_TIMEOUT', 30),
        connection: { application_name: 'cloudrun-prices' },
        onnotice: onPostgresNotice,
    });
    return cached;
}

export function makePostgresPricesRepo(sql: Sql): PricesRepo {
    return {
        async findLatestByCoinId(coinId) {
            const rows = await sql<CoingeckoPriceRow[]>`
                SELECT id, coin_id, price_usd, market_cap_usd, volume_24h_usd,
                       price_change_24h_percent, provider_last_updated_at,
                       last_fetched_at, created_at
                FROM coingecko_prices_latest
                WHERE coin_id = ${coinId}
                LIMIT 1
            `;
            return rows[0] ?? null;
        },
    };
}
