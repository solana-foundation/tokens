import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

import { CodeBlock } from '@/components/code-block';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
    return {
        ...defaultMdxComponents,
        pre: CodeBlock,
        ...components,
    };
}
