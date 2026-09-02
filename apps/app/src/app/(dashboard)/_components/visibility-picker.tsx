'use client';

import { Label } from '@tokens/ui/label';

/**
 * Public/Private choice for a community list, shared by the create dialog and
 * the settings modal. "Private" maps to the API's `unlisted` status: hidden
 * from the catalog (GET /api/v2/lists) but still readable at the direct URL.
 */
export function VisibilityPicker({
    isPrivate,
    onChange,
    disabled,
}: {
    isPrivate: boolean;
    onChange: (isPrivate: boolean) => void;
    disabled?: boolean;
}) {
    const options = [
        { value: false, title: 'Public', description: 'Shown in community lists' },
        { value: true, title: 'Private', description: 'Hidden from the catalog — link-only' },
    ] as const;
    return (
        <div className="space-y-1.5">
            <Label>Visibility</Label>
            <div role="radiogroup" aria-label="Visibility" className="grid grid-cols-2 gap-2">
                {options.map(option => {
                    const selected = isPrivate === option.value;
                    return (
                        <button
                            key={option.title}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={disabled}
                            onClick={() => onChange(option.value)}
                            className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                                selected
                                    ? 'border-foreground/40 bg-gray-50 dark:border-white/30 dark:bg-zinc-900'
                                    : 'border-black/[0.12] hover:border-black/25 dark:border-white/10 dark:hover:border-white/20'
                            }`}
                        >
                            <div className="text-sm font-inter-medium">{option.title}</div>
                            <div className="text-xs text-muted-foreground">{option.description}</div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
