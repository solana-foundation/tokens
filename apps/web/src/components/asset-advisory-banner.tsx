import { ArrowUpRight, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';
import { cn } from '@tokens/ui/cn';

import { TrackedAnchor, TrackedLink } from '@/components/tracked-link';
import { formatCompactAddress } from '@/app/token/[address]/lib/format';
import {
    advisoryBannerTitle,
    advisoryEventProps,
    advisoryReasonText,
    advisoryTone,
    formatAdvisorySince,
    siblingNoticeCopy,
    type AssetAdvisory,
    type AssetAdvisoryEntry,
} from '@/lib/asset-advisory';

interface AssetAdvisoryBannerProps {
    advisory: AssetAdvisory | null | undefined;
    /** Symbol of the viewed variant, used as the sentence subject. */
    symbol?: string | null;
    /** Mint of the viewed variant, attached to the read-more analytics event. */
    mint?: string | null;
    className?: string;
}

/**
 * Full-width warning rendered directly above the token header when the
 * viewed variant carries an advisory. Rose for compromised/blocked, amber for
 * caution. Server-renderable: the only client boundary is the tracked link.
 */
export function AssetAdvisoryBanner({ advisory, symbol, mint, className }: AssetAdvisoryBannerProps) {
    if (!advisory) return null;

    const tone = advisoryTone(advisory.status);
    const isDestructive = tone === 'destructive';
    const since = formatAdvisorySince(advisory.since);

    return (
        <Alert
            className={cn(
                'mb-6 rounded-2xl border px-5 py-4 shadow-[0_8px_40px_rgba(0,0,0,0.03)] [&>svg]:left-5 [&>svg]:top-[18px] [&>svg~*]:pl-8',
                isDestructive
                    ? 'border-rose-200 bg-rose-50 text-rose-950 [&>svg]:text-rose-600'
                    : 'border-amber-200 bg-amber-50 text-amber-950 [&>svg]:text-amber-600',
                className,
            )}
        >
            <TriangleAlert className="size-5" aria-hidden />
            <AlertTitle className="text-[15px] font-semibold leading-snug text-balance">
                {advisoryBannerTitle(advisory, symbol)}
            </AlertTitle>
            <AlertDescription
                className={cn('text-[14px] leading-relaxed text-pretty', isDestructive ? 'text-rose-900' : 'text-amber-900')}
            >
                <p>{advisoryReasonText(advisory)}</p>
                {since || advisory.url ? (
                    <div
                        className={cn(
                            'mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]',
                            isDestructive ? 'text-rose-800/80' : 'text-amber-800/80',
                        )}
                    >
                        {since ? <span>Flagged {since}</span> : null}
                        {advisory.url ? (
                            <TrackedAnchor
                                href={advisory.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                trackingEvent="external_link_clicked"
                                trackingProperties={advisoryEventProps(advisory, {
                                    link_type: 'advisory_read_more',
                                    link_url: advisory.url,
                                    source: 'advisory_banner',
                                    ...(mint ? { token_address: mint } : {}),
                                })}
                                className={cn(
                                    'inline-flex items-center gap-0.5 font-medium underline underline-offset-2 transition-colors',
                                    isDestructive
                                        ? 'text-rose-900 hover:text-rose-950'
                                        : 'text-amber-900 hover:text-amber-950',
                                )}
                            >
                                Read more
                                <ArrowUpRight className="size-3" aria-hidden />
                            </TrackedAnchor>
                        ) : null}
                    </div>
                ) : null}
            </AlertDescription>
        </Alert>
    );
}

interface AssetAdvisorySiblingNoticeProps {
    entries: readonly AssetAdvisoryEntry[];
    assetId: string;
    displayName: string;
    className?: string;
}

/**
 * Compact one-liner for the canonical view when a variant other than the
 * viewed one is flagged (e.g. `/silver` while SILV is compromised). Styled
 * like the data-source note; links are internal so they stay enabled.
 */
export function AssetAdvisorySiblingNotice({ entries, assetId, displayName, className }: AssetAdvisorySiblingNoticeProps) {
    if (entries.length === 0) return null;

    const hasDestructive = entries.some(entry => advisoryTone(entry.status) === 'destructive');

    return (
        <section
            className={cn(
                'mb-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-[13px] leading-relaxed',
                hasDestructive
                    ? 'border-rose-200 bg-rose-50/70 text-rose-900'
                    : 'border-amber-200 bg-amber-50/70 text-amber-900',
                className,
            )}
        >
            <TriangleAlert
                className={cn('mt-0.5 size-4 shrink-0', hasDestructive ? 'text-rose-600' : 'text-amber-600')}
                aria-hidden
            />
            <p className="min-w-0">
                {siblingNoticeCopy(entries, displayName)}{' '}
                <span className="inline-flex flex-wrap items-center gap-x-1">
                    {entries.map((entry, index) => (
                        <span key={entry.mint} className="inline-flex items-center">
                            <TrackedLink
                                href={`/${encodeURIComponent(assetId)}?solana=${encodeURIComponent(entry.mint)}`}
                                trackingEvent="variant_clicked"
                                trackingProperties={advisoryEventProps(entry, {
                                    asset_id: assetId,
                                    variant_mint: entry.mint,
                                    ...(entry.symbol ? { variant_symbol: entry.symbol } : {}),
                                    surface: 'advisory_sibling_notice',
                                })}
                                className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2 transition-colors hover:opacity-80"
                            >
                                {entry.symbol ? `$${entry.symbol}` : formatCompactAddress(entry.mint)}
                                <ArrowUpRight className="size-3" aria-hidden />
                            </TrackedLink>
                            {index < entries.length - 1 ? <span aria-hidden>,</span> : null}
                        </span>
                    ))}
                </span>
            </p>
        </section>
    );
}
