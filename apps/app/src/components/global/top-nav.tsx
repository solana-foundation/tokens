'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth, useUser, useClerk } from '@clerk/nextjs';
import { Badge } from '@tokens/ui/badge';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@tokens/ui/select';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import {
    IconPlus,
    //  IconGear,
} from 'symbols-react';
import { LogOut, Fingerprint } from 'lucide-react';
import { Button } from '@tokens/ui/button';
import { Logo } from '@/components/logo';
import { SignOutButton } from '@clerk/nextjs';
import { CreateProjectDialog } from '@/app/(dashboard)/_components/create-project-dialog';
import { useSelectedProject } from '@/hooks/use-selected-project';

export function TopNav() {
    // TopNav renders only inside the (dashboard) route group — auth routes
    // don't mount it (or any of the heavy providers) at all.
    const { isLoaded, isSignedIn } = useAuth();
    const isAuthenticated = Boolean(isLoaded && isSignedIn);
    const { user } = useUser();
    const { openUserProfile } = useClerk();

    // Use the shared selected project context
    const { selectedProjectId, setSelectedProjectId, userProjectsInfo } = useSelectedProject();

    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [isSelectOpen, setIsSelectOpen] = useState(false);

    // Handle project selection
    const handleProjectChange = (value: string) => {
        setSelectedProjectId(value);
    };

    // Handle profile click
    const handleProfileClick = () => {
        openUserProfile();
    };

    // Handle project creation completion
    const handleProjectCreated = (projectId: string) => {
        // Set the newly created project as selected
        setSelectedProjectId(projectId);
    };

    // Handle create project button click
    const handleCreateProjectClick = () => {
        setIsSelectOpen(false); // Close the select dropdown
        setIsCreateDialogOpen(true); // Open the create dialog
    };

    // Get user data
    const name = user?.fullName;
    const email = user?.primaryEmailAddress?.emailAddress;
    const avatarUrl = user?.imageUrl;

    // Determine tier badge variant and text
    const getTierInfo = (tier?: string) => {
        switch (tier?.toLowerCase()) {
            case 'pro':
                return { variant: 'default' as const, text: 'PRO' };
            case 'enterprise':
                return { variant: 'secondary' as const, text: 'ENT' };
            case 'free':
            default:
                return { variant: 'outline' as const, text: 'STANDARD' };
        }
    };

    return (
        <>
            <div className="border-b sticky border-black/10 border-b top-0 bg-zinc-100 dark:bg-zinc-900/80 backdrop-blur-sm z-40">
                <div className="w-full px-4">
                    <div className="flex justify-between items-center h-16">
                        <div className="flex items-center gap-3">
                            <Link
                                href="/"
                                className="flex flex-row items-center gap-2 transition-transform duration-150 ease-out active:scale-95 motion-reduce:transition-none"
                            >
                                <Logo className="h-7 w-7" />
                                <span className="text-lg text-black/10">|</span>
                            </Link>

                            {isAuthenticated && userProjectsInfo && (
                                <div className="min-w-[140px]">
                                    <Select
                                        value={selectedProjectId}
                                        onValueChange={handleProjectChange}
                                        open={isSelectOpen}
                                        onOpenChange={setIsSelectOpen}
                                    >
                                        <SelectTrigger className="w-full bg-white hover:bg-white/80 dark:hover:bg-zinc-800 border-black/10 hover:border-black/20 dark:hover:border-white/10 rounded-md cursor-pointer transition-all duration-150 hover:shadow-sm pr-2">
                                            <div className="flex items-center justify-between w-full">
                                                <SelectValue
                                                    placeholder={
                                                        userProjectsInfo?.defaultProject?.name || 'Select project'
                                                    }
                                                />
                                            </div>
                                        </SelectTrigger>
                                        <SelectContent className="w-56 bg-popover rounded-[12px]">
                                            {userProjectsInfo.projects.map(project => (
                                                <SelectItem key={project._id} value={project._id}>
                                                    <div className="flex items-center justify-between w-full">
                                                        <span className="text-text-extra-high">{project.name}</span>
                                                        <Badge
                                                            variant={getTierInfo(project.tier).variant}
                                                            className={`ml-2 text-[10px] py-0 px-1 !text-white ${getTierInfo(project.tier).variant === 'default' ? 'bg-amber-500 text-mono dark:bg-amber-500/50 border border-amber-900/30 dark:border-amber-500/30 rounded' : ' bg-blue-500 text-mono dark:bg-blue-500/50 border border-blue-900/30 dark:border-blue-500/30 rounded'}`}
                                                        >
                                                            {getTierInfo(project.tier).text}
                                                        </Badge>
                                                    </div>
                                                </SelectItem>
                                            ))}
                                            <SelectSeparator />
                                            <div className="w-full">
                                                <Button
                                                    variant="ghost"
                                                    className="group w-full h-8 rounded-md flex cursor-default select-none items-center px-2 py-1 text-sm"
                                                    onClick={handleCreateProjectClick}
                                                >
                                                    New Project
                                                    <IconPlus className="!size-2.5 fill-text-extra-low group-hover:fill-text-medium transition-all ease-in-out duration-150 group-hover:rotate-90" />
                                                </Button>
                                            </div>
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}
                        </div>

                        <div className="flex items-center gap-4">
                            {isAuthenticated && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            className="relative h-8 w-8"
                                            aria-label="Open user menu"
                                        >
                                            <Avatar className="h-8 w-8 rounded-full shadow-sm shadow-black/30 hover:ring-4 ring-1 ring-black/10 dark:ring-white/10 transition-all ease-in-out duration-150">
                                                {avatarUrl && (
                                                    <AvatarImage
                                                        src={avatarUrl}
                                                        alt={name || email?.split('@')[0] || 'User'}
                                                    />
                                                )}
                                                <AvatarFallback>
                                                    {email ? email.substring(0, 2).toUpperCase() : 'UN'}
                                                </AvatarFallback>
                                            </Avatar>
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent className="w-56 bg-popover" align="end" forceMount>
                                        <DropdownMenuLabel className="font-normal">
                                            <div className="flex flex-col space-y-1">
                                                <p className="text-sm font-medium leading-none">
                                                    {name || email?.split('@')[0] || 'User'}
                                                </p>
                                                <p className="text-xs leading-none text-muted-foreground">{email}</p>
                                            </div>
                                        </DropdownMenuLabel>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={handleProfileClick} className="cursor-pointer">
                                            <Fingerprint className="mr-2 h-4 w-4 text-text-extra-low" />
                                            Authentication
                                        </DropdownMenuItem>
                                        {/* <DropdownMenuItem>
                      <IconGear className="mr-2 h-4 w-4 fill-text-extra-low" />
                      Settings
                    </DropdownMenuItem> */}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem className="cursor-pointer w-full" asChild>
                                            <SignOutButton>
                                                <button className="w-full text-left flex items-center">
                                                    <LogOut className="mr-2 h-4 w-4 text-text-extra-low" />
                                                    Sign out
                                                </button>
                                            </SignOutButton>
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Create Project Dialog */}
            <CreateProjectDialog
                isOpen={isCreateDialogOpen}
                onOpenChange={setIsCreateDialogOpen}
                onProjectCreated={handleProjectCreated}
            />
        </>
    );
}
