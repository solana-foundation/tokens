import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { DocsNavTitle } from '@/components/docs-nav-title';

export function baseOptions(): BaseLayoutProps {
    return {
        themeSwitch: {
            enabled: false,
        },
        nav: {
            title: <DocsNavTitle />,
            url: '/',
        },
    };
}
