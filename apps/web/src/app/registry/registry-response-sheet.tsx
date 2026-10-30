'use client';

import { useMemo } from 'react';
import { CodeBlock } from '@solana/design-system/code-block';

import { Button } from '@tokens/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tokens/ui/sheet';
import { Skeleton } from '@tokens/ui/skeleton';
import { truncateAddress } from '@tokens/ui/cn';
import { CopyButton } from '@/components/copy-button';
import { useRegistryAsset } from '@/hooks/queries/use-registry-asset';
import { cleanTokenName } from '@/lib/logo-overrides';
import type { RegistryRow } from './lib/types';
import { RegistryTokenLogo } from './registry-token-logo';

const DOCS_URL = 'https://docs.tokens.xyz/v2/endpoints/registry';

function isNotFound(error: unknown): boolean {
    return (
        !!error &&
        typeof error === 'object' &&
        '_tag' in error &&
        error._tag === 'ApiResponseError' &&
        (error as { status?: number }).status === 404
    );
}

/**
 * Per-row "Response" sheet: the asset's `GET /v2/registry/{mint}` payload as
 * returned by the API, which carries our normalized item plus `upstream`, the
 * data.solana.com row verbatim. Everything the table no longer shows (group,
 * both provider classes, both provider values) is in here.
 */
export function RegistryResponseSheet({
    mint,
    row,
    onOpenChange,
}: {
    mint: string | null;
    row: RegistryRow | null;
    onOpenChange: (open: boolean) => void;
}) {
    const query = useRegistryAsset(mint);
    const code = useMemo(() => (query.data ? JSON.stringify(query.data, null, 2) : ''), [query.data]);
    const displayName = row ? (row.name ? cleanTokenName(row.name) : row.symbol) : (mint ?? '');

    return (
        <Sheet open={mint !== null} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full overflow-y-auto border-border-light p-0 sm:max-w-2xl">
                <SheetHeader className="border-b border-border-extra-light px-6 pb-4 pt-6 text-left">
                    <div className="flex items-center gap-3 pr-8">
                        {row ? <RegistryTokenLogo row={row} size={32} /> : null}
                        <div className="min-w-0">
                            <SheetTitle className="truncate text-[18px] font-medium text-text-extra-high">
                                {displayName}
                                {row?.name ? (
                                    <span className="ml-2 text-[14px] font-medium text-text-extra-low">
                                        ${row.symbol}
                                    </span>
                                ) : null}
                            </SheetTitle>
                            <SheetDescription className="mt-0.5 flex items-center gap-1.5 font-mono text-[12px] text-text-medium">
                                <span title={mint ?? undefined}>{mint ? truncateAddress(mint) : ''}</span>
                                {mint ? (
                                    <CopyButton
                                        textToCopy={mint}
                                        showText={false}
                                        ariaLabel="Copy mint address"
                                        className="size-6 rounded-md text-text-extra-low hover:text-text-medium"
                                        iconClassName="size-3.5"
                                    />
                                ) : null}
                            </SheetDescription>
                        </div>
                    </div>
                    <p className="mt-3 text-[13px] text-text-low">
                        The API response for this asset: our normalized fields plus{' '}
                        <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[12px] text-text-high">
                            upstream
                        </code>
                        , the data.solana.com row exactly as delivered.
                    </p>
                </SheetHeader>

                <div className="px-6 py-5">
                    {query.isPending ? (
                        <div className="space-y-2" aria-busy="true" aria-label="Loading response">
                            <Skeleton className="h-9 w-full rounded-lg bg-gray-100" />
                            {Array.from({ length: 14 }, (_, index) => (
                                <Skeleton
                                    key={index}
                                    className="h-4 rounded bg-gray-100"
                                    style={{ width: `${55 + ((index * 17) % 40)}%` }}
                                />
                            ))}
                        </div>
                    ) : query.isError ? (
                        <div className="rounded-2xl border border-border-light bg-gray-50/60 p-6 text-center">
                            {isNotFound(query.error) ? (
                                <>
                                    <p className="text-[14px] text-text-high">
                                        This asset is no longer in the registry
                                    </p>
                                    <p className="mt-1 text-[12px] text-text-low">
                                        The upstream dropped it since the table was loaded. Refresh the page to update
                                        the list.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p className="text-[14px] text-text-high">Could not load the response</p>
                                    <p className="mt-1 text-[12px] text-text-low">
                                        {query.error instanceof Error ? query.error.message : 'Try again in a moment.'}
                                    </p>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="mt-4 h-9 rounded-full border-border-medium bg-white px-4 font-sans text-[13px] shadow-none hover:bg-gray-50/60"
                                        onClick={() => void query.refetch()}
                                    >
                                        Retry
                                    </Button>
                                </>
                            )}
                        </div>
                    ) : (
                        <CodeBlock
                            ariaLabel={`API response for ${displayName}`}
                            code={code}
                            language="json"
                            filename={`GET /v2/registry/${mint ? truncateAddress(mint) : ''}`}
                            className="[&_.overflow-x-auto]:text-xs [&_.overflow-x-auto]:leading-6"
                        />
                    )}
                </div>

                <div className="border-t border-border-extra-light px-6 py-4 text-[12px] text-text-low">
                    Same payload any <code className="font-mono">assets:read</code> API key receives.{' '}
                    <a
                        href={DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-text-high underline-offset-2 hover:underline"
                    >
                        Endpoint docs
                    </a>
                </div>
            </SheetContent>
        </Sheet>
    );
}
