'use client';

import * as React from 'react';
import { Badge } from '@solana/design-system/badge';
import { CodeBlock } from '@solana/design-system/code-block';
import { Tab, TabList, TabPanel, Tabs } from '@solana/design-system/tabs';

/** Matches the api-manager playground so both surfaces read the same. */
const CODE_BLOCK_CLASS_NAME = '[&_.overflow-x-auto]:text-xs [&_.overflow-x-auto]:leading-6';
const CODE_MAX_HEIGHT_PX = 520;
/**
 * The composed URL shows the public API host, while this page's own request
 * goes to its same-origin proxy so the browser never holds a key.
 */
const PUBLIC_API_ORIGIN = 'https://api.tokens.xyz';

/** What each query param does, shared by both execution endpoints. */
const PARAM_DOCS: Record<string, string> = {
    assetId: 'Canonical asset id or alias — resolves to every variant we quote',
    mint: 'The exact Solana mint to quote',
    side: 'buy quotes USDC → token; sell quotes token → USDC',
    amountUsd: 'Order size in USDC, whole dollars',
    tokenAmount: "Sell size in the token's own units",
    providers: 'Comma-separated subset of jupiter, titan',
    maxVariants: 'Cap on how many variants get probed (1–6)',
    allocate: 'false returns the comparison without computing a split',
};

export interface EndpointRequestState {
    /** Wall-clock of the last completed request. */
    durationMs: number;
    status: number | 'error';
}

interface ComposedParam {
    key: string;
    values: string[];
    doc: string | undefined;
}

function composeRequest(requestPath: string): { path: string; params: ComposedParam[] } {
    const [path, query = ''] = requestPath.split('?');
    const grouped = new Map<string, string[]>();
    for (const [key, value] of new URLSearchParams(query)) {
        grouped.set(key, [...(grouped.get(key) ?? []), value]);
    }
    return {
        path: path!,
        params: [...grouped].map(([key, values]) => ({ key, values, doc: PARAM_DOCS[key] })),
    };
}

/** The endpoint this page is calling, broken into its parts, plus the raw response. */
export function EndpointRequestPanel({
    requestPath,
    responseJson,
    isPending,
    isError,
    lastRequest,
}: {
    /** Path + query exactly as the page's own fetch builds it. */
    requestPath: string;
    /** The last response body, or null before the first request. */
    responseJson: unknown;
    isPending: boolean;
    isError: boolean;
    lastRequest: EndpointRequestState | null;
}) {
    const [activeTab, setActiveTab] = React.useState('endpoint');
    const { path, params } = React.useMemo(() => composeRequest(requestPath), [requestPath]);

    const statusLabel = isPending
        ? 'Running…'
        : lastRequest
          ? lastRequest.status === 'error'
              ? 'Failed'
              : `${lastRequest.status} OK`
          : 'Not sent';
    const statusVariant = isPending || !lastRequest ? 'default' : isError ? 'danger' : 'success';

    const responseBody = React.useMemo(() => {
        if (responseJson === null || responseJson === undefined) return '// Run a request to see the response.';
        return JSON.stringify(responseJson, null, 2);
    }, [responseJson]);

    return (
        <section>
            <div className="mb-3">
                <h2 className="text-title-sm text-text-extra-high">The request</h2>
                <p className="mt-0.5 text-[11px] text-text-extra-low">
                    Everything on the left is one authenticated GET. Requires the{' '}
                    <code className="rounded bg-gray-100 px-1 py-0.5 text-[10px]">execution:read</code> scope.
                </p>
            </div>

            <Tabs size="md" bordered={false} fullWidth value={activeTab} onValueChange={setActiveTab}>
                <div className="mb-3 flex items-center justify-between gap-2">
                    <TabList className="w-max">
                        <Tab value="endpoint">Endpoint</Tab>
                        <Tab value="response">Response</Tab>
                    </TabList>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <Badge variant={statusVariant} dot className="font-mono">
                            {statusLabel}
                        </Badge>
                        {lastRequest && !isPending ? (
                            <Badge variant="default" className="font-mono">
                                {lastRequest.durationMs}ms
                            </Badge>
                        ) : null}
                    </div>
                </div>

                <TabPanel value="endpoint" className="pt-0">
                    <div className="space-y-4">
                        <div>
                            <div className="flex flex-wrap items-baseline gap-2">
                                <span className="rounded bg-gray-1400 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
                                    GET
                                </span>
                                <code className="break-all font-mono text-[12px] text-text-extra-high">{path}</code>
                            </div>
                            <p className="mt-1.5 break-all font-mono text-[11px] leading-5 text-text-low">
                                <span className="text-text-extra-low">{PUBLIC_API_ORIGIN}</span>
                                {path}
                                {params.length > 0 ? (
                                    <>
                                        <span className="text-text-extra-low">?</span>
                                        {params.flatMap((param, index) =>
                                            param.values.map((value, valueIndex) => (
                                                <React.Fragment key={`${param.key}-${valueIndex}`}>
                                                    {index + valueIndex > 0 ? (
                                                        <span className="text-text-extra-low">&amp;</span>
                                                    ) : null}
                                                    <span className="text-text-medium">{param.key}</span>
                                                    <span className="text-text-extra-low">=</span>
                                                    <span className="text-text-extra-high">{value}</span>
                                                </React.Fragment>
                                            )),
                                        )}
                                    </>
                                ) : null}
                            </p>
                        </div>

                        {params.length > 0 ? (
                            <dl className="divide-y divide-border-extra-light border-y border-border-extra-light">
                                {params.map(param => (
                                    <div key={param.key} className="grid grid-cols-[minmax(0,7rem)_1fr] gap-3 py-2">
                                        <dt className="font-mono text-[11px] text-text-high">{param.key}</dt>
                                        <dd className="min-w-0">
                                            <div className="flex flex-wrap gap-1">
                                                {param.values.map((value, index) => (
                                                    <code
                                                        key={index}
                                                        className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-text-extra-high tabular-nums"
                                                    >
                                                        {value}
                                                    </code>
                                                ))}
                                                {param.values.length > 1 ? (
                                                    <span className="self-center text-[10px] text-text-extra-low">
                                                        repeated {param.values.length}×
                                                    </span>
                                                ) : null}
                                            </div>
                                            {param.doc ? (
                                                <p className="mt-1 text-[11px] leading-4 text-text-low">{param.doc}</p>
                                            ) : null}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        ) : null}

                        <div>
                            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-extra-low">
                                Headers
                            </p>
                            <dl className="space-y-1">
                                {[
                                    ['x-api-key', '<YOUR_API_KEY>'],
                                    ['accept', 'application/json'],
                                ].map(([key, value]) => (
                                    <div key={key} className="flex flex-wrap items-baseline gap-2">
                                        <dt className="font-mono text-[11px] text-text-high">{key}</dt>
                                        <dd className="font-mono text-[11px] text-text-low">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    </div>
                </TabPanel>
                <TabPanel value="response" className="pt-0">
                    <CodeBlock
                        ariaLabel="Evaluation response"
                        code={responseBody}
                        language="json"
                        maxHeight={CODE_MAX_HEIGHT_PX}
                        className={CODE_BLOCK_CLASS_NAME}
                    />
                </TabPanel>
            </Tabs>
        </section>
    );
}
