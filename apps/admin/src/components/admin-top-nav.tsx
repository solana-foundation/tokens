'use client';

import Link from 'next/link';
import { SignOutButton, useClerk, useUser } from '@clerk/nextjs';
import { IconPersonBadgeKey, IconRectanglePortraitAndArrowRight } from 'symbols-react';

import { Logo } from '@/components/logo';
import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Button } from '@tokens/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';

export function AdminTopNav() {
    const { isSignedIn: isAuthenticated, user } = useUser();
    const { openUserProfile } = useClerk();

    const name = user?.fullName;
    const email = user?.primaryEmailAddress?.emailAddress;
    const avatarUrl = user?.imageUrl;
    const initials = email ? email.substring(0, 2).toUpperCase() : 'AD';

    return (
        <header className="sticky top-0 z-40 border-b border-black/10 bg-zinc-100/90 backdrop-blur-sm">
            <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
                <div className="flex items-center gap-3">
                    <Link
                        href="/curation"
                        className="flex items-center gap-2 transition-transform duration-150 ease-out active:scale-95 motion-reduce:transition-none"
                    >
                        <Logo className="h-7 w-7" />
                        <span className="text-lg font-inter-semibold text-foreground">Tokens</span>
                        <span className="text-lg text-black/10">|</span>
                    </Link>
                    <div className="hidden items-center gap-2 sm:flex">
                        <span className="rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-xs font-inter-medium text-muted-foreground shadow-sm">
                            Admin
                        </span>
                        <Link
                            href="/curation"
                            className="rounded-full px-3 py-1.5 text-sm font-inter-medium text-foreground transition-colors hover:bg-white/70"
                        >
                            Curation
                        </Link>
                        <Link
                            href="/launches"
                            className="rounded-full px-3 py-1.5 text-sm font-inter-medium text-foreground transition-colors hover:bg-white/70"
                        >
                            Launches
                        </Link>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Link
                        href={process.env.NEXT_PUBLIC_TOKENS_WEB_URL ?? 'https://tokens.xyz'}
                        className="hidden rounded-full px-3 py-1.5 text-sm font-inter-medium text-muted-foreground transition-colors hover:bg-white/70 hover:text-foreground sm:inline-flex"
                    >
                        View site
                    </Link>

                    {isAuthenticated ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    className="relative h-9 w-9 rounded-full"
                                    aria-label="Open user menu"
                                >
                                    <Avatar className="h-8 w-8 rounded-full shadow-sm ring-1 ring-black/10 transition-all duration-150 hover:ring-4">
                                        {avatarUrl ? (
                                            <AvatarImage src={avatarUrl} alt={name || email || 'Admin'} />
                                        ) : null}
                                        <AvatarFallback>{initials}</AvatarFallback>
                                    </Avatar>
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="w-56 rounded-[12px] bg-popover" align="end" forceMount>
                                <DropdownMenuLabel className="font-normal">
                                    <div className="flex flex-col space-y-1">
                                        <p className="text-sm font-medium leading-none">
                                            {name || email?.split('@')[0] || 'Admin'}
                                        </p>
                                        <p className="text-xs leading-none text-muted-foreground">{email}</p>
                                    </div>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => openUserProfile()} className="cursor-pointer">
                                    <IconPersonBadgeKey className="mr-2 h-4 w-4 fill-text-extra-low" />
                                    Authentication
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="cursor-pointer" asChild>
                                    <SignOutButton>
                                        <button className="flex w-full items-center text-left">
                                            <IconRectanglePortraitAndArrowRight className="mr-2 h-4 w-4 fill-text-extra-low" />
                                            Sign out
                                        </button>
                                    </SignOutButton>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                </div>
            </div>
        </header>
    );
}
