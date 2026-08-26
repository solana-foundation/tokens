'use client';

import * as React from 'react';
import { Badge } from '@solana/design-system/badge';
import { CodeBlock } from '@solana/design-system/code-block';
import { Tab, TabList, TabPanel, Tabs } from '@solana/design-system/tabs';

/** Matches the api-manager playground so both surfaces read the same. */
const CODE_BLOCK_CLASS_NAME = '[&_.overflow-x-auto]:text-xs [&_.overflow-x-auto]:leading-6';
const CODE_MAX_HEIGHT_PX = 520;
/**
 * Snippets show the public API host, while this page's own request goes to its
 * same-origin proxy so the browser never holds a key.
 */
const PUBLIC_API_ORIGIN = 'https://api.tokens.xyz';

export interface EndpointRequestState {
    /** Wall-clock of the last completed request. */
    durationMs: number;
    status: number | 'error';
}

export function buildEvaluateFetchSnippet(requestPath: string): string {
    return [
        'const API_KEY = "<YOUR_API_KEY>";',
        '',
        `const response = await fetch(\`${PUBLIC_API_ORIGIN}${requestPath}\`, {`,
        '  headers: {',
        '    "x-api-key": API_KEY,',
        '    "accept": "application/json",',
        '  },',
        '});',
        '',
        'const { quotes, meta } = await response.json();',
        '',
        '// Who won each size, and by how much it mattered.',
        'for (const quote of quotes) {',
        '  if (quote.status !== "available") continue;',
        '  console.log(',
        '    quote.request.amount,',
        '    quote.best.provider,',
        '    quote.edge ? `+${quote.edge.bps}bps (+$${quote.edge.usd})` : "uncontested",',
        '  );',
        '}',
        '',
        'console.log(meta.summary.bestProvider, meta.summary.medianEdgeBps);',
        '',
    ].join('\n');
}

export function buildRouteFetchSnippet(requestPath: string): string {
    return [
        'const API_KEY = "<YOUR_API_KEY>";',
        '',
        `const response = await fetch(\`${PUBLIC_API_ORIGIN}${requestPath}\`, {`,
        '  headers: {',
        '    "x-api-key": API_KEY,',
        '    "accept": "application/json",',
        '  },',
        '});',
        '',
        'const { allocation, variants, meta } = await response.json();',
        '',
        '// The plan: how to split the order across variants right now.',
        'if (allocation) {',
        '  for (const leg of allocation.legs) {',
        '    console.log(leg.symbol, `$${leg.amountUsd}`, leg.provider, leg.expectedOut?.amount);',
        '  }',
        '  const edge = allocation.edge.vsBestSingleVariant;',
        '  if (edge) console.log(`beats all-in ${edge.baselineSymbol} by ${edge.bps}bps (+$${edge.usd})`);',
        '}',
        '',
        '// The evidence: every variant, every probed size, both routers.',
        'console.log(variants.length, "variants quoted,", meta.upstreamQuotes, "upstream quotes");',
        '',
    ].join('\n');
}

/** Shows the exact request this page is making (path from the fetch's own builder). */
export function EndpointRequestPanel({
    snippet,
    responseJson,
    isPending,
    isError,
    lastRequest,
}: {
    snippet: string;
    /** The last response body, or null before the first request. */
    responseJson: unknown;
    isPending: boolean;
    isError: boolean;
    lastRequest: EndpointRequestState | null;
}) {
    const [activeTab, setActiveTab] = React.useState('code');

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
        <section className="rounded-[24px] border border-border-medium bg-white p-4 shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
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
                        <Tab value="code">Code</Tab>
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

                <TabPanel value="code" className="pt-0">
                    <CodeBlock
                        ariaLabel="Evaluation request code"
                        code={snippet}
                        language="javascript"
                        maxHeight={CODE_MAX_HEIGHT_PX}
                        className={CODE_BLOCK_CLASS_NAME}
                    />
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
