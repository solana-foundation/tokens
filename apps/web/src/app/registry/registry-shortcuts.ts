/**
 * Guard for single-letter global shortcuts (F = Add filter, Esc = clear).
 * Returns true when the keystroke should be treated as TYPING, not a
 * shortcut: any modifier held, focus in an editable element, or an open
 * dialog/popover (its own inputs own the keyboard there).
 */
export function isTypingContext(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return true;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;

    if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
    ) {
        return true;
    }

    return target.closest('[role="dialog"], [data-radix-popper-content-wrapper]') !== null;
}

/**
 * True while a Radix popover/dialog is open anywhere on the page. Radix keeps
 * the popper wrapper mounted through the close animation, so check the
 * content's own open state rather than the wrapper's presence.
 */
export function hasOpenOverlay(): boolean {
    return (
        document.querySelector(
            '[data-radix-popper-content-wrapper] [data-state="open"], [role="dialog"][data-state="open"]',
        ) !== null
    );
}
