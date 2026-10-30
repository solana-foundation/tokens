'use client';

import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@tokens/ui/dialog';
import { Button } from '@tokens/ui/button';

interface RevokeConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    symbol: string;
    mint: string;
    quoteSymbol: string | null;
    isBusy?: boolean;
    onConfirm: () => void;
}

export function RevokeConfirmDialog({
    open,
    onOpenChange,
    symbol,
    mint,
    quoteSymbol,
    isBusy = false,
    onConfirm,
}: RevokeConfirmDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Revoke {symbol}?</DialogTitle>
                    <DialogDescription>
                        <span className="font-mono text-xs">{mint}</span> will disappear from the launches API and from
                        the {quoteSymbol ? `${quoteSymbol} ` : ''}asset page within a couple of minutes. The synced row
                        is kept, so it can be approved again later.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline" disabled={isBusy}>
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button variant="destructive" onClick={onConfirm} disabled={isBusy}>
                        {isBusy ? 'Revoking…' : 'Revoke'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
