import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/spacious';

import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
    return (
        <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
            {children}
        </DocsLayout>
    );
}
