import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons';
import { docs } from 'fumadocs-mdx:collections/server';

export const source = loader({
    baseUrl: '/',
    source: docs.toFumadocsSource(),
    plugins: [lucideIconsPlugin()],
});
