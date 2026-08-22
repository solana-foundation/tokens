import { ListsUi } from './lists-ui';
import { hasUsableClerkPublishableKey } from '@/lib/clerk-config';

export default async function Page() {
    const adminApiUrl = process.env.TOKENS_CLOUDRUN_ADMIN_URL?.trim();
    const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
    if (!adminApiUrl || !hasUsableClerkPublishableKey(clerkPublishableKey)) {
        return (
            <div className="mx-auto max-w-2xl p-6">
                <div className="rounded-md border border-border-medium bg-card p-4 text-body-md">
                    <div className="font-inter-medium">Admin app is not configured</div>
                    <div className="text-muted-foreground">
                        Set `TOKENS_CLOUDRUN_ADMIN_URL` and Clerk env vars before using list oversight.
                    </div>
                </div>
            </div>
        );
    }

    return <ListsUi />;
}
