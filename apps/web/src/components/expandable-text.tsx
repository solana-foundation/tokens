'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

interface ExpandableTextProps {
    text: string;
    maxLines?: number;
    className?: string;
    /**
     * When false, anchors are stripped from the sanitized HTML (tag and
     * href/target/rel). Used on advisory-flagged tokens so a 300s-cached
     * profile description can't route readers to a compromised site.
     */
    allowLinks?: boolean;
}

const SANITIZE_ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li', 'span'];
const SANITIZE_ALLOWED_ATTR = ['href', 'target', 'rel', 'class'];
const SANITIZE_ALLOWED_TAGS_NO_LINKS = SANITIZE_ALLOWED_TAGS.filter(tag => tag !== 'a');
const SANITIZE_ALLOWED_ATTR_NO_LINKS = SANITIZE_ALLOWED_ATTR.filter(attr => attr === 'class');

interface DomPurifyLike {
    sanitize: (html: string, config?: unknown) => string;
}

type CreateDomPurify = (window: Window) => DomPurifyLike;

function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function createFallbackHtml(text: string): string {
    // Conservative fallback for SSR / before hydration:
    // - drop all tags (keep readability)
    // - preserve basic line breaks from common tags
    const withoutTags = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]*>/g, '');

    return escapeHtml(withoutTags).replace(/\n/g, '<br />').trim();
}

export function ExpandableText({ text, maxLines = 7, className = '', allowLinks = true }: ExpandableTextProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isTruncated, setIsTruncated] = useState(false);
    const fallbackHtml = useMemo(() => createFallbackHtml(text), [text]);
    const [sanitizedHtml, setSanitizedHtml] = useState(fallbackHtml);
    const textRef = useRef<HTMLDivElement>(null);

    // Sanitize HTML content (client-only) to keep SSR stable.
    useEffect(() => {
        let isActive = true;
        setSanitizedHtml(fallbackHtml);

        async function sanitize() {
            try {
                const mod = await import('dompurify');
                const dompurify: unknown = mod.default;
                const purifier =
                    typeof dompurify === 'function'
                        ? (dompurify as CreateDomPurify)(window)
                        : (dompurify as DomPurifyLike);

                const clean = purifier.sanitize(text, {
                    ALLOWED_TAGS: allowLinks ? SANITIZE_ALLOWED_TAGS : SANITIZE_ALLOWED_TAGS_NO_LINKS,
                    ALLOWED_ATTR: allowLinks ? SANITIZE_ALLOWED_ATTR : SANITIZE_ALLOWED_ATTR_NO_LINKS,
                });

                if (!isActive) return;
                setSanitizedHtml(clean);
            } catch {
                // Keep fallbackHtml
            }
        }

        sanitize();
        return () => {
            isActive = false;
        };
    }, [allowLinks, fallbackHtml, text]);

    useLayoutEffect(() => {
        const el = textRef.current;
        if (!el) return;

        // Check if content is truncated
        const checkTruncation = () => {
            // Method 1: Compare scroll height to client height
            const isOverflowing = el.scrollHeight > el.clientHeight + 1;

            // Method 2: Fallback - estimate based on character count (~80 chars per line)
            const estimatedLines = text.length / 80;
            const likelyTruncated = estimatedLines > maxLines;

            setIsTruncated(isOverflowing || likelyTruncated);
        };

        // Run after a small delay to ensure styles are applied
        requestAnimationFrame(() => {
            checkTruncation();
        });

        // Recheck on resize
        window.addEventListener('resize', checkTruncation);
        return () => window.removeEventListener('resize', checkTruncation);
    }, [sanitizedHtml, text, maxLines]);

    return (
        <div>
            {/* Text container with overlay */}
            <div className="relative">
                <div
                    ref={textRef}
                    className={`
                        text-[14px] text-text-high leading-[1.5]
                        [&>p]:mb-4 [&>p:last-child]:mb-0
                        [&>br]:block [&>br]:mb-2
                        [&_a]:text-text-high [&_a]:underline [&_a]:underline-offset-2 
                        [&_a:hover]:text-text-extra-high
                        [&_strong]:font-semibold [&_b]:font-semibold
                        [&_em]:italic [&_i]:italic
                        [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-4
                        [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-4
                        [&_li]:mb-1
                        ${className}
                    `}
                    style={
                        !isExpanded
                            ? {
                                  display: '-webkit-box',
                                  WebkitLineClamp: maxLines,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                  ...(isTruncated
                                      ? {
                                            // Fade the text out to transparent without painting a background color.
                                            WebkitMaskImage:
                                                'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) calc(100% - 5rem), rgba(0,0,0,0) 100%)',
                                            maskImage:
                                                'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) calc(100% - 5rem), rgba(0,0,0,0) 100%)',
                                            WebkitMaskRepeat: 'no-repeat',
                                            maskRepeat: 'no-repeat',
                                            WebkitMaskSize: '100% 100%',
                                            maskSize: '100% 100%',
                                        }
                                      : {}),
                              }
                            : undefined
                    }
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
            </div>

            {/* Read more / Show less button - outside the overlay container */}
            {isTruncated && (
                <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-text-low hover:text-text-extra-high font-medium transition-colors"
                >
                    {isExpanded ? (
                        <>
                            Show less
                            <ChevronUpIcon className="w-3.5 h-3.5" />
                        </>
                    ) : (
                        <>
                            Read more
                            <ChevronDownIcon className="w-3.5 h-3.5" />
                        </>
                    )}
                </button>
            )}
        </div>
    );
}

function ChevronDownIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    );
}

function ChevronUpIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m18 15-6-6-6 6" />
        </svg>
    );
}
