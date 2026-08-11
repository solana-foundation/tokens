import type { Metadata } from 'next';
import { MarketExplorer } from './market-explorer';

export const metadata: Metadata = {
    title: 'Market Data',
    description: 'Tokens, ETFs, stocks, metals and tokenized real-world assets in one table.',
};

export default function MarketPage() {
    return <MarketExplorer />;
}
