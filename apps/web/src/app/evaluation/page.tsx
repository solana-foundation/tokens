import type { Metadata } from 'next';

import { EvaluationPlayground } from './evaluation-playground';

export const metadata: Metadata = {
    title: 'Execution Evaluation',
    description: 'Internal playground for the /v2/execution/evaluate endpoint.',
    // Internal demo surface: reachable by URL, not linked or indexed.
    robots: { index: false, follow: false },
};

export default function EvaluationPage() {
    return <EvaluationPlayground />;
}
