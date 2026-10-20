/**
 * Initial region/industry tags for the curated `stocks` list (migration 0032).
 *
 * Applied once per environment through the admin "Import region/industry
 * tags" action (`applyAssetTagsImport`, default mode `fill_empty`), which
 * writes with `admin_edited_at` set. After that the admin edit dialog owns the
 * values; re-running the import never overwrites a hand edit.
 *
 * Conventions (review notes inline as `// review:`):
 * - `region` is where the company is headquartered / domiciled. Multinationals
 *   keep their HQ region; `global` is reserved for funds without a home market.
 * - Thematic ETFs take their theme; broad or multi-issuer funds (index
 *   trackers, bond/credit/commodity baskets) are `index_fund`; single-commodity
 *   trusts are `materials` / `energy`.
 * - Bitcoin/ETH/SOL treasury companies → `crypto_treasury`; miners →
 *   `crypto_mining`; venues/brokerages → `crypto_exchange`; payments → `fintech`.
 * - Video-game publishers → `software`; streaming/film/TV → `media`.
 *
 * Keyed by the asset's current `assetId` (matched case-insensitively, and
 * through former ids left by admin renames). Ondo per-mint singletons
 * (`stock-*`) carry no name or symbol in the database, so they are
 * intentionally absent; the import preview lists them under "untagged" so
 * they can be tagged in the edit dialog once their identity is known.
 */

import type { AssetIndustry, AssetRegion } from '@tokens/asset-registry';

export interface AssetTagsRow {
    region: AssetRegion;
    industry: AssetIndustry;
}

export const ASSET_TAGS_INITIAL: Readonly<Record<string, AssetTagsRow>> = {
    // PreStocks pre-IPO singletons and Ondo's Strategy preferred keep their
    // per-mint ids; they are listed up front because they sort oddly.
    'pre-pre8arem': { region: 'north_america', industry: 'fintech' }, // Polymarket (prediction market)
    'pre-prec1ktj': { region: 'north_america', industry: 'software' }, // xAI
    'pre-prelwgkk': { region: 'north_america', industry: 'fintech' }, // Kalshi (prediction market)
    'pre-pren1fvf': { region: 'north_america', industry: 'software' }, // Anthropic
    'pre-prestj4y': { region: 'north_america', industry: 'defense' }, // Anduril
    strcon: { region: 'north_america', industry: 'crypto_treasury' }, // Strategy (STRC preferred, Ondo-tokenized)
    abbott: { region: 'north_america', industry: 'healthcare' },
    abbvie: { region: 'north_america', industry: 'pharma' },
    'abrdn-physical-palladium-shares-etf': { region: 'global', industry: 'materials' },
    accenture: { region: 'europe', industry: 'software' }, // review: Dublin-domiciled IT services
    adobe: { region: 'north_america', industry: 'software' },
    airbnb: { region: 'north_america', industry: 'travel_leisure' },
    alibaba: { region: 'asia', industry: 'internet' },
    alphabet: { region: 'north_america', industry: 'internet' },
    amazon: { region: 'north_america', industry: 'internet' },
    amber: { region: 'asia', industry: 'fintech' }, // review: Amber International (digital-asset wealth mgmt, Singapore)
    'amc-entertainment': { region: 'north_america', industry: 'media' },
    amd: { region: 'north_america', industry: 'semiconductors' },
    'american-airlines-group': { region: 'north_america', industry: 'travel_leisure' },
    'american-express': { region: 'north_america', industry: 'fintech' },
    amgen: { region: 'north_america', industry: 'biotech' },
    'analog-devices': { region: 'north_america', industry: 'semiconductors' },
    'apollo-global-management': { region: 'north_america', industry: 'asset_management' },
    apple: { region: 'north_america', industry: 'hardware' },
    'applied-materials': { region: 'north_america', industry: 'semiconductors' },
    applovin: { region: 'north_america', industry: 'software' },
    'archer-aviation': { region: 'north_america', industry: 'aerospace' },
    'arista-networks': { region: 'north_america', industry: 'hardware' },
    'arm-holdings-plc': { region: 'europe', industry: 'semiconductors' },
    asml: { region: 'europe', industry: 'semiconductors' },
    'ast-spacemobile': { region: 'north_america', industry: 'telecom' },
    astrazeneca: { region: 'europe', industry: 'pharma' },
    atandt: { region: 'north_america', industry: 'telecom' },
    b2gold: { region: 'north_america', industry: 'materials' },
    baidu: { region: 'asia', industry: 'internet' },
    'bank-of-america': { region: 'north_america', industry: 'banking' },
    'bending-spoons': { region: 'europe', industry: 'software' },
    'berkshire-hathaway': { region: 'north_america', industry: 'conglomerate' },
    'bigbear-ai-holdings': { region: 'north_america', industry: 'defense' }, // review: defense/intel AI contractor
    bilibili: { region: 'asia', industry: 'media' },
    'bit-digital': { region: 'north_america', industry: 'crypto_mining' },
    bitfufu: { region: 'asia', industry: 'crypto_mining' },
    bitmine: { region: 'north_america', industry: 'crypto_treasury' },
    blackrock: { region: 'north_america', industry: 'asset_management' },
    block: { region: 'north_america', industry: 'fintech' },
    boeing: { region: 'north_america', industry: 'aerospace' },
    booking: { region: 'north_america', industry: 'travel_leisure' },
    broadcom: { region: 'north_america', industry: 'semiconductors' },
    bullish: { region: 'north_america', industry: 'crypto_exchange' }, // review: Cayman-incorporated, NYSE-listed
    'capital-one': { region: 'north_america', industry: 'banking' },
    carvana: { region: 'north_america', industry: 'retail' },
    caterpillar: { region: 'north_america', industry: 'manufacturing' },
    'charles-schwab': { region: 'north_america', industry: 'asset_management' },
    chevron: { region: 'north_america', industry: 'energy' },
    chipotle: { region: 'north_america', industry: 'food_beverage' },
    'cipher-mining': { region: 'north_america', industry: 'crypto_mining' },
    circle: { region: 'north_america', industry: 'fintech' },
    cisco: { region: 'north_america', industry: 'hardware' },
    citigroup: { region: 'north_america', industry: 'banking' },
    cleanspark: { region: 'north_america', industry: 'crypto_mining' },
    'coca-cola': { region: 'north_america', industry: 'food_beverage' },
    coinbase: { region: 'north_america', industry: 'crypto_exchange' },
    comcast: { region: 'north_america', industry: 'media' },
    conocophillips: { region: 'north_america', industry: 'energy' },
    'constellation-energy': { region: 'north_america', industry: 'utilities' },
    'core-scientific': { region: 'north_america', industry: 'crypto_mining' },
    costco: { region: 'north_america', industry: 'retail' },
    coupang: { region: 'asia', industry: 'internet' },
    crowdstrike: { region: 'north_america', industry: 'software' },
    'd-wave-quantum': { region: 'north_america', industry: 'hardware' },
    danaher: { region: 'north_america', industry: 'healthcare' },
    deere: { region: 'north_america', industry: 'manufacturing' },
    'defi-development': { region: 'north_america', industry: 'crypto_treasury' },
    'denison-mines': { region: 'north_america', industry: 'energy' }, // review: uranium miner (Canada)
    disney: { region: 'north_america', industry: 'media' },
    doordash: { region: 'north_america', industry: 'internet' },
    duolingo: { region: 'north_america', industry: 'software' },
    ebay: { region: 'north_america', industry: 'internet' },
    'eli-lilly': { region: 'north_america', industry: 'pharma' },
    equinix: { region: 'north_america', industry: 'real_estate' },
    expedia: { region: 'north_america', industry: 'travel_leisure' },
    'exxon-mobil': { region: 'north_america', industry: 'energy' },
    figma: { region: 'north_america', industry: 'software' },
    'figure-technology-solutions': { region: 'north_america', industry: 'fintech' },
    'first-trust-global-tactical-commodity-strategy-fund': { region: 'global', industry: 'index_fund' },
    'ford-motor': { region: 'north_america', industry: 'automotive' },
    'futu-holdings': { region: 'asia', industry: 'fintech' },
    'galaxy-digital': { region: 'north_america', industry: 'crypto_exchange' }, // review: trading/asset mgmt/mining mix
    gamestop: { region: 'north_america', industry: 'retail' },
    'gemini-space-station': { region: 'north_america', industry: 'crypto_exchange' },
    'general-electric': { region: 'north_america', industry: 'aerospace' },
    'goldman-sachs': { region: 'north_america', industry: 'banking' },
    'grab-holdings': { region: 'asia', industry: 'internet' },
    grindr: { region: 'north_america', industry: 'internet' },
    'helius-medical': { region: 'north_america', industry: 'crypto_treasury' }, // review: now "Solana Company" (SOL treasury)
    'hims-and-hers-health': { region: 'north_america', industry: 'healthcare' },
    'home-depot': { region: 'north_america', industry: 'retail' },
    honeywell: { region: 'north_america', industry: 'manufacturing' },
    'hut-8': { region: 'north_america', industry: 'crypto_mining' },
    ibm: { region: 'north_america', industry: 'software' },
    'iboxx-high-yield-corporate-bond-etf': { region: 'north_america', industry: 'index_fund' },
    intel: { region: 'north_america', industry: 'semiconductors' },
    intuit: { region: 'north_america', industry: 'software' },
    'intuitive-surgical': { region: 'north_america', industry: 'healthcare' },
    'invesco-db-commodity-index-tracking-fund': { region: 'global', industry: 'index_fund' },
    'invesco-optimum-yld-dvsfd-cmd-str-no-k-1-etf': { region: 'global', industry: 'index_fund' },
    'invesco-qqq': { region: 'north_america', industry: 'index_fund' },
    iren: { region: 'oceania', industry: 'crypto_mining' },
    'ishares-0-3-month-treasury-bond-etf': { region: 'north_america', industry: 'index_fund' },
    'ishares-flexible-income-active-etf': { region: 'north_america', industry: 'index_fund' },
    'ishares-tips-bond-etf': { region: 'north_america', industry: 'index_fund' },
    'janus-henderson-aaa-clo-etf': { region: 'north_america', industry: 'index_fund' },
    'jd-com': { region: 'asia', industry: 'internet' },
    'johnson-and-johnson': { region: 'north_america', industry: 'pharma' },
    'jpmorgan-chase': { region: 'north_america', industry: 'banking' },
    kanzhun: { region: 'asia', industry: 'internet' },
    kla: { region: 'north_america', industry: 'semiconductors' },
    'lam-research': { region: 'north_america', industry: 'semiconductors' },
    'li-auto': { region: 'asia', industry: 'automotive' },
    linde: { region: 'europe', industry: 'materials' },
    lockheed: { region: 'north_america', industry: 'defense' },
    'lowe-s': { region: 'north_america', industry: 'retail' },
    lululemon: { region: 'north_america', industry: 'consumer_goods' },
    mara: { region: 'north_america', industry: 'crypto_mining' },
    marvell: { region: 'north_america', industry: 'semiconductors' },
    mastec: { region: 'north_america', industry: 'manufacturing' }, // review: infrastructure construction
    mastercard: { region: 'north_america', industry: 'fintech' },
    'mcdonald-s': { region: 'north_america', industry: 'food_beverage' },
    medtronic: { region: 'europe', industry: 'healthcare' }, // review: Dublin-domiciled, operations in Minneapolis
    mercadolibre: { region: 'latin_america', industry: 'internet' },
    merck: { region: 'north_america', industry: 'pharma' },
    meta: { region: 'north_america', industry: 'internet' },
    micron: { region: 'north_america', industry: 'semiconductors' },
    microsoft: { region: 'north_america', industry: 'software' },
    microstrategy: { region: 'north_america', industry: 'crypto_treasury' },
    moderna: { region: 'north_america', industry: 'biotech' },
    monster: { region: 'north_america', industry: 'food_beverage' },
    'mp-materials': { region: 'north_america', industry: 'materials' },
    nebius: { region: 'europe', industry: 'software' }, // review: AI cloud infrastructure (Amsterdam)
    netease: { region: 'asia', industry: 'software' },
    netflix: { region: 'north_america', industry: 'media' },
    'nextera-energy': { region: 'north_america', industry: 'utilities' },
    nike: { region: 'north_america', industry: 'consumer_goods' },
    nio: { region: 'asia', industry: 'automotive' },
    'novo-nordisk': { region: 'europe', industry: 'pharma' },
    nvidia: { region: 'north_america', industry: 'semiconductors' },
    'occidental-petroleum': { region: 'north_america', industry: 'energy' },
    oil: { region: 'global', industry: 'energy' }, // review: crude-oil tracker listed under stocks
    oklo: { region: 'north_america', industry: 'energy' },
    'on-semiconductor': { region: 'north_america', industry: 'semiconductors' },
    'ondas-holdings': { region: 'north_america', industry: 'defense' }, // review: drones + private wireless
    open: { region: 'north_america', industry: 'real_estate' }, // review: Opendoor (ticker OPEN), not OpenAI
    openai: { region: 'north_america', industry: 'software' },
    opera: { region: 'europe', industry: 'internet' },
    oracle: { region: 'north_america', industry: 'software' },
    'oscar-health': { region: 'north_america', industry: 'insurance' },
    palantir: { region: 'north_america', industry: 'software' },
    'palo-alto-networks': { region: 'north_america', industry: 'software' },
    paypal: { region: 'north_america', industry: 'fintech' },
    'pdd-holdings': { region: 'asia', industry: 'internet' },
    pepsico: { region: 'north_america', industry: 'food_beverage' },
    petrobras: { region: 'latin_america', industry: 'energy' },
    pfizer: { region: 'north_america', industry: 'pharma' },
    pgande: { region: 'north_america', industry: 'utilities' },
    'philip-morris': { region: 'north_america', industry: 'consumer_goods' },
    pinterest: { region: 'north_america', industry: 'internet' },
    'planet-labs': { region: 'north_america', industry: 'aerospace' },
    'plug-power': { region: 'north_america', industry: 'energy' },
    'procter-and-gamble': { region: 'north_america', industry: 'consumer_goods' },
    'proshares-short-qqq': { region: 'north_america', industry: 'index_fund' },
    qualcomm: { region: 'north_america', industry: 'semiconductors' },
    reddit: { region: 'north_america', industry: 'internet' },
    'rigetti-computing': { region: 'north_america', industry: 'hardware' },
    'riot-platforms': { region: 'north_america', industry: 'crypto_mining' },
    'rivian-automotive': { region: 'north_america', industry: 'automotive' },
    robinhood: { region: 'north_america', industry: 'fintech' },
    roblox: { region: 'north_america', industry: 'software' },
    'rocket-lab': { region: 'north_america', industry: 'aerospace' },
    'roundhill-memory-etf': { region: 'global', industry: 'semiconductors' },
    rtx: { region: 'north_america', industry: 'defense' },
    salesforce: { region: 'north_america', industry: 'software' },
    sandisk: { region: 'north_america', industry: 'semiconductors' },
    'sandp-global': { region: 'north_america', industry: 'fintech' }, // review: ratings / financial data
    servicenow: { region: 'north_america', industry: 'software' },
    'sharplink-gaming': { region: 'north_america', industry: 'crypto_treasury' },
    shopify: { region: 'north_america', industry: 'software' },
    'sk-hynix': { region: 'asia', industry: 'semiconductors' },
    snap: { region: 'north_america', industry: 'internet' },
    snowflake: { region: 'north_america', industry: 'software' },
    'sofi-technologies': { region: 'north_america', industry: 'fintech' },
    'soundhound-ai': { region: 'north_america', industry: 'software' },
    southern: { region: 'north_america', industry: 'utilities' },
    spacex: { region: 'north_america', industry: 'aerospace' },
    spotify: { region: 'europe', industry: 'media' },
    'sprott-nickel-miners-etf': { region: 'global', industry: 'materials' },
    starbucks: { region: 'north_america', industry: 'food_beverage' },
    'super-micro-computer': { region: 'north_america', industry: 'hardware' },
    't-mobile': { region: 'north_america', industry: 'telecom' },
    'take-two-interactive': { region: 'north_america', industry: 'software' },
    'talen-energy': { region: 'north_america', industry: 'utilities' },
    target: { region: 'north_america', industry: 'retail' },
    'tempus-ai': { region: 'north_america', industry: 'healthcare' },
    terawulf: { region: 'north_america', industry: 'crypto_mining' },
    tesla: { region: 'north_america', industry: 'automotive' },
    'texas-instruments': { region: 'north_america', industry: 'semiconductors' },
    'thermo-fisher': { region: 'north_america', industry: 'healthcare' },
    ton: { region: 'north_america', industry: 'crypto_treasury' }, // review: TON Strategy Co (ex-Verb Technology)
    toyota: { region: 'asia', industry: 'automotive' },
    'trip-com-group': { region: 'asia', industry: 'travel_leisure' },
    tsmc: { region: 'asia', industry: 'semiconductors' },
    uber: { region: 'north_america', industry: 'internet' },
    unitedhealth: { region: 'north_america', industry: 'healthcare' },
    'vaneck-clo-etf': { region: 'north_america', industry: 'index_fund' },
    'vaneck-rare-earth-and-strategic-metals-etf': { region: 'global', industry: 'materials' },
    'vanguard-value-etf': { region: 'north_america', industry: 'index_fund' },
    verizon: { region: 'north_america', industry: 'telecom' },
    vertiv: { region: 'north_america', industry: 'manufacturing' },
    'virgin-galactic': { region: 'north_america', industry: 'aerospace' },
    visa: { region: 'north_america', industry: 'fintech' },
    vistra: { region: 'north_america', industry: 'utilities' },
    walmart: { region: 'north_america', industry: 'retail' },
    'warner-bros': { region: 'north_america', industry: 'media' },
    'wells-fargo': { region: 'north_america', industry: 'banking' },
    'wendy-s': { region: 'north_america', industry: 'food_beverage' },
    'wisdomtree-floating-rate-treasury-fund': { region: 'north_america', industry: 'index_fund' },
    'wisdomtree-us-quality-dividend-growth-fund': { region: 'north_america', industry: 'index_fund' },
};
