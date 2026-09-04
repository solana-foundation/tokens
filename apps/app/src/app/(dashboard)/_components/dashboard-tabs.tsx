'use client';

import {
    Component,
    useState,
    useEffect,
    useCallback,
    type ComponentProps,
    type ErrorInfo,
    type ReactNode,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import dynamic from 'next/dynamic';
import { IconCircleGridCrossFill, IconKeySlashFill } from 'symbols-react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { ApiKeyDisplay } from '@/components/api-manager/api-key-display';
import { useDashboardMutation, useDashboardQuery } from '@/hooks/use-dashboard-api';
import type { ApiKeyResetResult, ProjectDoc } from '@/lib/dashboard-types';
import { ProjectHeader } from './project-header';
import { EmptyState } from '@/components/global/empty-state';
import { Button } from '@tokens/ui/button';
import { Skeleton } from '@tokens/ui/skeleton';
import { Spinner } from '@tokens/ui/spinner';
import { useProjectApiKeys } from '@/contexts/project-api-keys';
import { type DashboardTabId, useDashboardTab } from '@/hooks/use-dashboard-tab';
import type { ChartData, EndpointPerformance, UsageStats } from './dashboard-types';
import { normalizeApiKeyReveal } from '@/components/api-manager/api-key-reveal';

type ProjectHeaderProject = ComponentProps<typeof ProjectHeader>['project'];

const isCompletelyEmpty = (
    usageStats: UsageStats | undefined | null,
    chartData: ChartData[] | undefined,
    endpointPerformance: EndpointPerformance[] | undefined,
) => {
    // While loading, prefer the skeleton UI over the "empty" state.
    if (usageStats === undefined || chartData === undefined || endpointPerformance === undefined) {
        return false;
    }

    return (
        (!usageStats ||
            (usageStats.totalApiCalls === 0 &&
                usageStats.totalApiOperationsThisMonth === 0 &&
                usageStats.uniqueUsers === 0)) &&
        (!chartData || chartData.length === 0 || chartData.every(d => d.apiCalls === 0 && d.users === 0)) &&
        (!endpointPerformance || endpointPerformance.length === 0)
    );
};

interface UsageChartsProps {
    chartData: ChartData[] | undefined;
    usageStats: UsageStats | null | undefined;
    endpointPerformance: EndpointPerformance[] | undefined;
}

function UsageChartsLoading() {
    return (
        <div className="space-y-4">
            <div className="rounded-[12px] bg-gray-100/60 overflow-hidden p-0.5">
                <div className="bg-white dark:bg-zinc-950/30 border border-black/[0.15] rounded-lg shadow-sm overflow-hidden p-6">
                    <Skeleton className="h-[560px] w-full" />
                </div>
            </div>
        </div>
    );
}

const UsageCharts = dynamic<UsageChartsProps>(() => import('./usage-charts').then(mod => mod.UsageCharts), {
    ssr: false,
    loading: () => <UsageChartsLoading />,
});

interface ApiManagerToolTabsProps {
    projectId: string;
    apiKeyId: string | null;
    apiKey: string;
    hasActiveApiKey: boolean;
}

function ToolTabsLoading() {
    return (
        <div className="w-full">
            <div className="h-[34px] w-[240px] rounded-md bg-gray-100/60 p-1">
                <div className="flex h-full items-center gap-2 px-2">
                    <Skeleton className="h-6 w-16" />
                    <Skeleton className="h-6 w-16" />
                </div>
            </div>
            <div className="mt-6 relative px-2">
                <div className="rounded-[12px] bg-gray-100/60 overflow-hidden p-0.5">
                    <div className="bg-white border border-black/20 rounded-lg shadow-sm overflow-hidden p-6">
                        <Skeleton className="h-[320px] w-full" />
                    </div>
                </div>
            </div>
        </div>
    );
}

const ToolTabs = dynamic<ApiManagerToolTabsProps>(
    () => import('@/components/api-manager/tool-tabs').then(mod => mod.ToolTabs),
    {
        ssr: false,
        loading: () => <ToolTabsLoading />,
    },
);

const ListsTab = dynamic(() => import('./lists-tab').then(mod => mod.ListsTab), {
    ssr: false,
    loading: () => <ToolTabsLoading />,
});

class UsageQueryErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
    state = { hasError: false };

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error: unknown, info: ErrorInfo) {
        console.error('Usage dashboard query failed', error, info.componentStack);
    }

    render() {
        if (this.state.hasError) return this.props.fallback;
        return this.props.children;
    }
}

function UsageUnavailableState({
    project,
    onViewApiKeys,
}: {
    project: ProjectHeaderProject;
    onViewApiKeys: () => void;
}) {
    return (
        <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
            <ProjectHeader project={project} />

            <div className="relative z-10 bg-background/80 backdrop-blur-sm rounded-2xl border border-dashed border-black/20 py-12">
                <EmptyState
                    icon={<IconCircleGridCrossFill className="size-[60px] mb-2 fill-muted-foreground" />}
                    title="Usage data unavailable"
                    subtitle="API keys and playground are still available while usage analytics recover."
                    className="p-12 w-full sm:w-[420px] mx-auto"
                />

                <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    className="flex flex-col sm:flex-row gap-3 justify-center"
                >
                    <Button variant="outline" onClick={onViewApiKeys} size="sm">
                        View API Keys
                    </Button>
                </motion.div>
            </div>
        </div>
    );
}

const USAGE_POLL_MS = 30_000;

function OverviewTabContent({
    isAuthenticated,
    projectId,
    project,
    onViewApiKeys,
}: {
    isAuthenticated: boolean;
    projectId: string | null;
    project: ProjectHeaderProject;
    onViewApiKeys: () => void;
}) {
    const { data: usageStatsData } = useDashboardQuery<UsageStats | null>(
        'usageGetProjectUsageStats',
        isAuthenticated && projectId ? { projectId } : 'skip',
        { refetchIntervalMs: USAGE_POLL_MS },
    );

    const { data: chartData } = useDashboardQuery<ChartData[]>(
        'usageGetProjectUsageTimeSeries',
        isAuthenticated && projectId ? { projectId, days: 30 } : 'skip',
        { refetchIntervalMs: USAGE_POLL_MS },
    );

    const { data: endpointPerformance } = useDashboardQuery<EndpointPerformance[]>(
        'usageGetEndpointPerformance',
        isAuthenticated && projectId ? { projectId, days: 30 } : 'skip',
        { refetchIntervalMs: USAGE_POLL_MS },
    );

    const isEmpty = isCompletelyEmpty(usageStatsData, chartData, endpointPerformance);

    if (isEmpty) {
        return (
            <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                <ProjectHeader project={project} />

                <div className="relative z-10 bg-background/80 backdrop-blur-sm rounded-2xl border border-dashed border-black/20 py-12">
                    <EmptyState
                        icon={<IconCircleGridCrossFill className="size-[60px] mb-2 fill-muted-foreground" />}
                        title="Welcome to Tokens!"
                        subtitle="Don't worry your dashboard will come alive once you start using your API"
                        className="p-12 w-full sm:w-[420px] mx-auto"
                    />

                    <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        className="flex flex-col sm:flex-row gap-3 justify-center"
                    >
                        <Button variant="outline" onClick={onViewApiKeys} size="sm">
                            View API Keys
                        </Button>
                        <Button asChild variant="ghost" className="rounded-lg" size="sm">
                            <Link href="https://docs.tokens.xyz" target="_blank" rel="noreferrer">
                                Read Documentation
                            </Link>
                        </Button>
                    </motion.div>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
            <ProjectHeader project={project} />

            <UsageCharts chartData={chartData} usageStats={usageStatsData} endpointPerformance={endpointPerformance} />
        </div>
    );
}

export default function DashboardTabs() {
    const [isInitialLoad, setIsInitialLoad] = useState(true);
    const { tab, setTab } = useDashboardTab();
    const resetApiKey = useDashboardMutation<ApiKeyResetResult>('apiKeysReset');
    const [isCreatingApiKey, setIsCreatingApiKey] = useState(false);
    const [createApiKeyError, setCreateApiKeyError] = useState<string | null>(null);

    const { isLoaded, isSignedIn } = useAuth();
    const isAuthenticated = Boolean(isLoaded && isSignedIn);
    const {
        projectId,
        apiKeysCount,
        hasActiveApiKey,
        activeApiKeyCanReveal,
        currentApiKey,
        currentApiKeyId,
        currentApiKeyIsFresh,
        onApiKeyReset,
    } = useProjectApiKeys();

    const { data: project } = useDashboardQuery<ProjectDoc | null>(
        'usersGetProjectById',
        projectId ? { projectId } : 'skip',
    );

    useEffect(() => {
        setIsInitialLoad(false);
    }, []);

    const handleTabClick = useCallback(
        (id: DashboardTabId) => {
            setTab(id);
        },
        [setTab],
    );

    const handleCreateApiKey = useCallback(async () => {
        if (!projectId) return;

        setCreateApiKeyError(null);
        setIsCreatingApiKey(true);
        try {
            const result = await resetApiKey({ projectId });
            const reveal = normalizeApiKeyReveal(result);
            if (!reveal) throw new Error('API key creation did not return a reveal value');
            onApiKeyReset(reveal.rawKey, reveal.apiKeyId);
        } catch (error) {
            setCreateApiKeyError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsCreatingApiKey(false);
        }
    }, [onApiKeyReset, projectId, resetApiKey]);

    function renderTabContent() {
        switch (tab) {
            case 'overview': {
                return (
                    <UsageQueryErrorBoundary
                        key={projectId ?? 'no-project'}
                        fallback={
                            <UsageUnavailableState
                                project={project}
                                onViewApiKeys={() => handleTabClick('api-manager')}
                            />
                        }
                    >
                        <OverviewTabContent
                            isAuthenticated={isAuthenticated}
                            projectId={projectId}
                            project={project}
                            onViewApiKeys={() => handleTabClick('api-manager')}
                        />
                    </UsageQueryErrorBoundary>
                );
            }
            case 'api-manager': {
                if (!projectId || apiKeysCount === null) {
                    return (
                        <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                            <div className="mb-6 space-y-2">
                                <Skeleton className="h-9 w-48" />
                                <Skeleton className="h-4 w-[520px] max-w-full" />
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                                <div className="relative overflow-hidden rounded-xl border border-black/20 bg-white shadow-sm">
                                    <div className="p-6 space-y-4">
                                        <Skeleton className="h-5 w-32" />
                                        <Skeleton className="h-4 w-80 max-w-full" />
                                        <Skeleton className="h-11 w-full" />
                                        <div className="flex gap-2">
                                            <Skeleton className="h-9 w-28" />
                                            <Skeleton className="h-9 w-28" />
                                        </div>
                                    </div>
                                </div>

                                <div className="relative rounded-[20px] bg-gray-100/60 overflow-hidden p-1">
                                    <div className="bg-white border border-black/20 rounded-2xl shadow-sm overflow-hidden p-4 space-y-4">
                                        <div className="flex items-center justify-between">
                                            <Skeleton className="h-5 w-40" />
                                            <Skeleton className="h-6 w-16 rounded" />
                                        </div>
                                        <div className="space-y-3">
                                            <Skeleton className="h-3 w-full" />
                                            <Skeleton className="h-3 w-full" />
                                            <Skeleton className="h-3 w-full" />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="w-full">
                                <div className="h-[34px] w-[240px] rounded-md bg-gray-100/60 p-1">
                                    <div className="flex h-full items-center gap-2 px-2">
                                        <Skeleton className="h-6 w-16" />
                                        <Skeleton className="h-6 w-16" />
                                    </div>
                                </div>
                                <div className="mt-6 relative px-2">
                                    <div className="rounded-[12px] bg-gray-100/60 overflow-hidden p-0.5">
                                        <div className="bg-white border border-black/20 rounded-lg shadow-sm overflow-hidden p-6">
                                            <Skeleton className="h-[320px] w-full" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                }

                // No keys yet: show a full-page empty state with a clear CTA.
                if (!currentApiKey && apiKeysCount === 0) {
                    return (
                        <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                            <div className="mb-6">
                                <h1 className="text-3xl font-bold text-foreground">API Manager</h1>
                                <p className="text-muted-foreground">
                                    Create an API key to authenticate requests and unlock the API Playground.
                                </p>
                            </div>

                            <div className="relative z-10 bg-background/80 backdrop-blur-sm rounded-2xl border border-dashed border-black/20 py-12">
                                <EmptyState
                                    icon={<IconKeySlashFill className="size-[60px] mb-2 fill-muted-foreground" />}
                                    title="No API keys found"
                                    subtitle="Create your first API key to get started"
                                    className="p-12 w-full sm:w-[420px] mx-auto"
                                />

                                <motion.div
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.22, ease: 'easeOut' }}
                                    className="flex flex-col sm:flex-row gap-3 justify-center"
                                >
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => void handleCreateApiKey()}
                                        disabled={isCreatingApiKey}
                                        size="sm"
                                    >
                                        {isCreatingApiKey ? (
                                            <span className="inline-flex items-center gap-2">
                                                <Spinner size="sm" />
                                                Creating…
                                            </span>
                                        ) : (
                                            'Create API key'
                                        )}
                                    </Button>

                                    <Button asChild variant="ghost" className="rounded-lg" size="sm">
                                        <Link href="https://docs.tokens.xyz" target="_blank" rel="noreferrer">
                                            Read Documentation
                                        </Link>
                                    </Button>
                                </motion.div>

                                {createApiKeyError && (
                                    <div className="mt-6 mx-auto w-full max-w-[520px] px-6">
                                        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                                            {createApiKeyError}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                }

                return (
                    <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                        <div className="mb-6">
                            <h1 className="text-3xl font-bold text-foreground">API Manager</h1>
                            <p className="text-muted-foreground">
                                Manage your API keys and test integrations against the Tokens API
                            </p>
                        </div>
                        <div className="grid grid-cols-1 gap-12 items-end">
                            <ApiKeyDisplay
                                fullApiKey={currentApiKey}
                                apiKeyId={currentApiKeyId}
                                isFreshApiKey={currentApiKeyIsFresh}
                                hasApiKey={hasActiveApiKey}
                                canRevealApiKey={currentApiKeyIsFresh || activeApiKeyCanReveal}
                                projectId={projectId}
                                onApiKeyReset={onApiKeyReset}
                            />
                        </div>

                        <ToolTabs
                            projectId={projectId}
                            apiKeyId={currentApiKeyId}
                            apiKey={currentApiKey}
                            hasActiveApiKey={hasActiveApiKey}
                        />
                    </div>
                );
            }
            case 'lists': {
                return <ListsTab />;
            }
            default:
                return null;
        }
    }

    return (
        <div className="w-full">
            {/* Tab Content with Animation */}
            <div className="relative">
                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={tab}
                        initial={isInitialLoad ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{
                            duration: 0.2,
                            ease: 'easeOut',
                        }}
                    >
                        {renderTabContent()}
                    </motion.div>
                </AnimatePresence>
            </div>
        </div>
    );
}
