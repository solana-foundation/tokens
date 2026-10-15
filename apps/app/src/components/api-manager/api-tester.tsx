'use client';

import { useCallback, useState } from 'react';

import {
    ApiPlaygroundShell,
    API_PLAYGROUND_OMIT_VALUE,
    type ApiPlaygroundEndpointConfig,
} from './api-playground-shell';

type ApiTesterEndpointId = 'search' | 'curated' | 'asset' | 'variants';

function coerceEndpointId(raw: string): ApiTesterEndpointId {
    switch (raw) {
        case 'curated':
        case 'asset':
        case 'variants':
            return raw;
        default:
            return 'search';
    }
}

const ENDPOINTS: Array<ApiPlaygroundEndpointConfig> = [
    {
        id: 'search',
        title: 'Search assets',
        method: 'GET',
        path: '/api/v1/assets/search',
        queryFields: [
            {
                key: 'q',
                label: 'q',
                placeholder: 'e.g. solana, ethereum, jupiter',
                required: true,
            },
            {
                key: 'limit',
                label: 'limit',
                placeholder: '20',
                defaultValue: '20',
                inputType: 'number',
            },
            {
                key: 'category',
                label: 'category (optional)',
                placeholder: 'e.g. crypto, equity, etf',
            },
            {
                key: 'region',
                label: 'region (optional)',
                placeholder: 'e.g. asia, europe, north_america',
            },
            {
                key: 'industry',
                label: 'industry (optional)',
                placeholder: 'e.g. manufacturing, defense, software',
            },
        ],
        expectedResponse: {
            query: 'solana',
            category: null,
            region: null,
            industry: null,
            results: [],
        },
    },
    {
        id: 'curated',
        title: 'Curated assets',
        method: 'GET',
        path: '/api/v1/assets/curated',
        queryFields: [
            {
                key: 'list',
                label: 'list',
                kind: 'select',
                defaultValue: 'all',
                options: [
                    { label: 'all', value: 'all' },
                    { label: 'majors', value: 'majors' },
                    { label: 'lsts', value: 'lsts' },
                    { label: 'currencies', value: 'currencies' },
                    { label: 'rwas', value: 'rwas' },
                    { label: 'etfs', value: 'etfs' },
                    { label: 'metals', value: 'metals' },
                    { label: 'stocks', value: 'stocks' },
                ],
            },
            {
                key: 'groupBy',
                label: 'groupBy',
                kind: 'select',
                defaultValue: 'asset',
                options: [
                    { label: 'asset', value: 'asset' },
                    { label: 'mint', value: 'mint' },
                ],
            },
            {
                key: 'region',
                label: 'region (optional)',
                placeholder: 'e.g. asia, europe, north_america',
            },
            {
                key: 'industry',
                label: 'industry (optional)',
                placeholder: 'e.g. manufacturing, defense, software',
            },
        ],
        expectedResponse: {
            listId: 'all',
            assets: [],
        },
    },
    {
        id: 'asset',
        title: 'Get asset',
        method: 'GET',
        path: '/api/v1/assets/{assetId}',
        pathFields: [
            {
                key: 'assetId',
                label: 'assetId',
                placeholder: 'e.g. solana',
                required: true,
            },
        ],
        queryFields: [
            {
                key: 'include',
                label: 'include (optional)',
                kind: 'select',
                defaultValue: 'profile,risk',
                options: [
                    { label: 'profile,risk', value: 'profile,risk' },
                    { label: 'profile,risk,ohlcv', value: 'profile,risk,ohlcv' },
                    { label: 'profile,risk,markets', value: 'profile,risk,markets' },
                    { label: 'profile,risk,ohlcv,markets', value: 'profile,risk,ohlcv,markets' },
                    { label: 'none', value: API_PLAYGROUND_OMIT_VALUE },
                ],
            },
        ],
        expectedResponse: {
            asset: {
                assetId: 'solana',
                name: 'Solana',
                symbol: 'SOL',
                category: 'crypto',
                aliases: [],
                symbols: [],
                imageUrl: null,
                stats: null,
                variantGroups: [],
                primaryVariant: null,
            },
            includes: {},
        },
    },
    {
        id: 'variants',
        title: 'List variants',
        method: 'GET',
        path: '/api/v1/assets/{assetId}/variants',
        pathFields: [
            {
                key: 'assetId',
                label: 'assetId',
                placeholder: 'e.g. solana',
                required: true,
            },
        ],
        queryFields: [
            {
                key: 'kind',
                label: 'kind (optional)',
                kind: 'select',
                defaultValue: API_PLAYGROUND_OMIT_VALUE,
                options: [
                    { label: '(any)', value: API_PLAYGROUND_OMIT_VALUE },
                    { label: 'native', value: 'native' },
                    { label: 'wrapped', value: 'wrapped' },
                    { label: 'bridged', value: 'bridged' },
                    { label: 'spot', value: 'spot' },
                    { label: 'stablecoin', value: 'stablecoin' },
                    { label: 'lst', value: 'lst' },
                    { label: 'yield', value: 'yield' },
                    { label: 'etf', value: 'etf' },
                    { label: 'tokenized_equity', value: 'tokenized_equity' },
                    { label: 'basket', value: 'basket' },
                    { label: 'leveraged', value: 'leveraged' },
                ],
            },
            {
                key: 'liquidityTier',
                label: 'liquidityTier (optional)',
                kind: 'select',
                defaultValue: API_PLAYGROUND_OMIT_VALUE,
                options: [
                    { label: '(any)', value: API_PLAYGROUND_OMIT_VALUE },
                    { label: 'tier1', value: 'tier1' },
                    { label: 'tier2', value: 'tier2' },
                    { label: 'tier3', value: 'tier3' },
                ],
            },
            {
                key: 'trustTier',
                label: 'trustTier (deprecated)',
                kind: 'select',
                defaultValue: API_PLAYGROUND_OMIT_VALUE,
                options: [
                    { label: '(any)', value: API_PLAYGROUND_OMIT_VALUE },
                    { label: 'tier1', value: 'tier1' },
                    { label: 'tier2', value: 'tier2' },
                    { label: 'tier3', value: 'tier3' },
                    { label: 'experimental (legacy)', value: 'experimental' },
                ],
            },
        ],
        expectedResponse: {
            assetId: 'solana',
            variants: [],
        },
    },
];

export interface ApiTesterProps {
    apiKey: string;
    projectId: string;
    apiKeyId: string | null;
    hasActiveApiKey: boolean;
}

export function ApiTester({ apiKey, projectId, apiKeyId, hasActiveApiKey }: ApiTesterProps) {
    const [activeEndpointId, setActiveEndpointId] = useState<ApiTesterEndpointId>('search');

    const handleEndpointChange = useCallback((endpointId: string) => {
        setActiveEndpointId(coerceEndpointId(endpointId));
    }, []);

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-md font-semibold mb-0">API Playground</h3>
                <p className="text-sm text-muted-foreground">Explore `apps/api` endpoints with live requests</p>
            </div>

            <ApiPlaygroundShell
                apiKey={apiKey}
                projectId={projectId}
                apiKeyId={apiKeyId}
                hasActiveApiKey={hasActiveApiKey}
                endpoints={ENDPOINTS}
                productName="Tokens"
                activeEndpointId={activeEndpointId}
                onEndpointChange={handleEndpointChange}
            />
        </div>
    );
}
