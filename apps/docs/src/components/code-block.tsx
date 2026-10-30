'use client';

import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@tokens/ui/cn';

import { playCopySheen } from '@/lib/copy-sheen';

const COPIED_MS = 1500;

type CodeBlockProps = Omit<ComponentProps<'pre'>, 'title'> & {
    /** Injected by Fumadocs' rehype-code; these blocks render without a title bar. */
    icon?: ReactNode;
    title?: ReactNode;
};

/** Text to copy: shell sessions with `.prompt` markers copy only their commands. */
function codeText(pre: HTMLElement): string {
    const text = pre.textContent ?? '';
    if (!pre.querySelector('.prompt')) return text;
    return text
        .split('\n')
        .filter((line) => line.startsWith('$ '))
        .map((line) => line.slice(2))
        .join('\n');
}

export function CodeBlock({ icon: _icon, title: _title, className, children, ...props }: CodeBlockProps) {
    const preRef = useRef<HTMLPreElement>(null);
    const resetRef = useRef<number | undefined>(undefined);
    const [copied, setCopied] = useState(false);

    useEffect(() => () => window.clearTimeout(resetRef.current), []);

    const onCopy = useCallback(async () => {
        const pre = preRef.current;
        if (!pre) return;
        try {
            await navigator.clipboard.writeText(codeText(pre));
        } catch {
            return;
        }
        playCopySheen(pre);
        setCopied(true);
        window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    }, []);

    return (
        <div className="tk-code-block not-prose">
            <pre ref={preRef} className={cn(className)} {...props}>
                {children}
            </pre>
            <button
                type="button"
                className="tk-copy-code"
                aria-label={copied ? 'Copied' : 'Copy code'}
                data-copied={copied ? '' : undefined}
                onClick={onCopy}
            >
                <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <g className="tk-copy-idle">
                        <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
                        <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" />
                    </g>
                    <path className="tk-copy-done" d="M3.5 8.5l3 3 6-7" />
                </svg>
            </button>
        </div>
    );
}
