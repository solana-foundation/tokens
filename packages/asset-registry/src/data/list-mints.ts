import { ONDO_STOCK_MINTS_20260618 } from './ondo-stock-mints';

/**
 * Canonical-asset generation inputs, grouped by the curated list each batch
 * originally shipped under. These arrays define which mints the registry
 * builds assets/variants for — they are NOT live list membership. Membership
 * authority is the database (`asset_collections` / `asset_collection_members`),
 * edited via the admin app.
 *
 * Array order is semantic (it seeded DB rank); append, never sort.
 */

export const MAJORS_MINTS: readonly string[] = [
    'So11111111111111111111111111111111111111112', // SOL
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Wormhole)
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', // cbBTC (Coinbase)
    'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS', // ZEC (OmniBridge)
    '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', // HYPE (Wormhole)
    'CrAr4RRJMBVwRsZtT62pEhfA9H5utymC2mVx8e7FreP2', // MON (Wrapped)
    'GbbesPbaYh5uiAZSYNXTc7w9jty1rpg3P9L4JeN4LkKc', // TRX (Bridged)
    '9gP2kCy3wA1ctvYWQk75guqXuHfrEomqydHLtcTCqiLa', // BNB (Wormhole)
    '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG', // NEAR
    'soKqZS9pASwBNS46G388nhK7XVtPaTyReffXEd3zora', // ZORA
    'HsRpHQn6VbyMs5b5j5SV6xQ2VvpvvCCzu19GjytVSCoz', // STARKNET
    'avaxGHCq3T7hoxd73oY2KY9hJSTaeMibXvHy5KNzh5D', // AVAX (Wormhole)
    'suifhC9gU1VbJAPYPTBkHJyyyStKGLLYPVDTmPoqbvA', // SUI
    '6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2', // wXRP (Hex Trust)
    'chipCAT7vi5CZtbZsn9z7iMPXvFwyAnKz3QFu8XVuHm', // CHIP
    '6eftxVbSAunVEoxUWdGhPdxg5UdsJ8Wkwy5w5YFuxouw', // CHZ
    'AavE1kKKnesPw4MuRJmJ9jZs9QzEE8CPxQ3ViczUDfc1', // AAVE
    'inxKXw9V2NDZE7hDijzpJaKKUb97NEPJDTCEEiYg4yY', // INX
    'EicWvteVi2fWepEzS3FYWsnuPoP6caZfjnKqNvydLjCH', // LIT
    'DmcqxT7WXgXhq2LHURQ2h8GA5PeCBuMTLeyaj6MXhf3p', // DMC
    'BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy', // BP
    '3ywtR9qQH4BuA7LSfLvEuW1gh6ha7EK18XwLbHvhryPZ', // DIME
    'BWsnyEa1XtsNRdgPaDoA1WVUonF7BBGZTd2zc72NQsWT', // BLEND
    'megaA5QDK1qLXtjpvg9oCFMvxT9d5BCMrVTBddnM5kV', // MEGA
    'taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY', // TAO
    '72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1', // ENA
    '8FU95xFJhUUkyyCLU13HSzDLs7oC4QZdXQHL6SCeab36', // UNI
    'Bi11Je4MH3PpyCNiuTAepRbsA5U6DK3DJy79ZFthddX', // BILL
    'Dst93spXQEXxFzwYbFrQRnFYBYpw7AzB2QyALEeP4NGQ', // AFC
    '5eyib4qghYGHNh7VvxSFGYLFJSanjq9hug9fR52kksnm', // PSG
    '7JoGUTeaXkjcMGa6xJP2idYNYiLreto1WnsACHnpw3Gd', // DEUS
    'ARXwZkNAtzPfdcoqQiduJn8EPv9fKiDfGn2KyggyDrFs', // ARX
];

export const LST_MINTS: readonly string[] = [
    'sctmWXGT7L75psrUHV2xxyTQKndE7ZcCQRHy2z6D5ER', // honestSOL
    'StPsoHokZryePePFV8N7iXvfEmgUoJ87rivABX7gaW6', // stepSOL
    'BPSoLzmLQn47EP5aa7jmFngRL8KC3TWAeAwXwZD8ip3P', // bpSOL
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85', // BNSOL
    'Bybit2vBJGhPF52GBdNaQfUJ6ZpThSgHBobjWZpLPb4B', // bbSOL
    'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // JupSOL
    'pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL', // PSOL
    'hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT', // hyloSOL
    'sctmB7GPi5L2Q5G9tUSzXvhZ4YiDMEGcRov9KfArQpx', // dfdvSOL
    'sctmAy9zFfZznZUWxEMgGtF6PHZ3gwoiCGcfwRua1AZ', // sctmSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // Added
];

export const CURRENCY_MINTS: readonly string[] = [
    'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9', // AUSD
    'A94X2fRy3wydNShU4dRaDyap2UuoeWJGWyATtyp61WZf', // TRYB (BiLira)
    'GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr', // BUIDL (BlackRock USD Institutional Digital Liquidity Fund)
    'FtgGSFADXBtroxq8VCausXRr2of47QBf5AS1NtZCu4GD', // BRZ
    'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH', // CASH
    'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', // EURC
    'DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52', // EURCV (EUR CoinVertible)
    '2VhjJ9WxaGC3EZFwJG9BDUs9KxKCAjQY4vgd1qxgYWVg', // EUROe (EUROe Stablecoin)
    '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u', // FDUSD (First Digital USD)
    'GGUSDyBUPFg5RrgWwqEqhXoha85iYGs6cL57SyK4G2Y7', // GGUSD
    '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG (Global Dollar)
    'Crn4x1Y2HUKko7ox2EZMT6N2t2ZyH7eKtwkBGVnhEq1g', // GYEN (GMO JPY)
    'idrxTdNftk6tYedPv2M7tCFHBVCpk5rkiNRd8yUArhr', // IDRX
    '52GzcLDMfBveMRnWXKX7U3Pa5Lf7QLkWWvsJRDjWDBSk', // NGNC (NGN Coin)
    'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', // USDY (Ondo US Dollar Yield)
    'ZPFtoCe7WWqG4N3ZFRccS8T9SMBeHsd1Vmgv2i7ondo', // USD (Ondo U.S. Dollar Token)
    'HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM', // USDP (Pax Dollar)
    'APhcqtzE73es3KAGiVksZFMLGwJDiAey5qZKUrQHEHfS', // SOFIUSD
    'HVWf8JmLoHs99Lw8Psf3fyqAtA4crWxCPkrmSdNjhNH3', // USDPT (U.S. Dollar Payment Token)
    '72puLt71H93Z9CzHuBRTwFpL4TG3WZUhnoCC7p8gxigu', // USDtb
    '8yXrtJ54jZtE84xEBzTESKuegjcAkAuDrdAhRd8i8n3T', // USDtb
    '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E', // hyUSD
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD (PayPal USD)
    'BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6', // legacyUSD* (Legacy USD Star)
    'star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM', // USD* (USD Star)
    '6zYgzrT7X2wi9a9NeMtUvUWLLmf2a8vBsbYkocYdB9wa', // MXNe (Real MXN)
    'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
    'susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X', // sUSD (Solayer USD)
    'AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj', // syrupUSDC (Syrup USDC)
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (USD Coin)
    'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', // USDe
    '9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy', // USDu
    '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', // USX
    '2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW', // tGBP (Tokenised GBP)
    '71S9cppWipeUEQDFngYwxjoxB6Sz1MUqX72byLsVYJqy', // XSGD
    '4UbvZiomFvXDnZSz6vdHiDNiHozH2ykTEqjhhbVHiv9z', // XUSD
    '5H4voZhzySsVvwVYDAKku8MZGuYBC7cXaBKDPW4YHWW1', // VGBP (VNX British Pound)
    'C4Kkr9NZU3VbyedcgutU6LKmi6MKz81sx6gRmk5pX519', // VEUR (VNX Euro)
    'AhhdRu5YZdjVkKR3wbnUDaymVQL2ucjMQ63sZ3LFHsch', // VCHF (VNX Swiss Franc)
    'myrcAs6bpP2g5oGHZ3qpgrfZQAFkbo9KUHdqYDXMjGv', // MYRC
    'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1 (World Liberty Financial USD)
    'dngKhBQM3BGvsDHKhrLnjvRKfY5Q7gEnYGToj9Lk8rk', // ZARP (ZARP Stablecoin)
    'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', // Added

    // Missing Birdeye token_overview symbol (these would show as "???" without filtering).
    'AUDDttiEpCydTm7joUMbYddm72jAWXZnCpPZtDoxqBSw',
];

export const RWA_MINTS: readonly string[] = [
    '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6', // TBILL (OpenEden T-Bills)
    '34mJztT9am2jybSukvjNqRjgJBZqHJsHnivArx1P4xy1', // VBILL (VanEck Treasury Fund)
    'i7u4r16TcsJTgq1kAG8opmVZyVnAKBwLKu6ZPMwzxNc', // OUSG (Ondo Short-Term US Gov Bond Fund)
    'CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2', // USTB (Superstate Short Duration US Government Securities Fund)
    'USTRYnGgcHAhdWsanv8BG6vHGd4p7UGgoB9NRd8ei7j', // USTRY (Etherfuse USTRY)
    '5Tu84fKBpe9vfXeotjvfvWdWbAjy3hqsExvuHgFqFxA1', // BENJI
    'XsqBC5tcVQLYt8wqGCHRnAUUecbRYXoJCReD6w7QEKp', // TBLL

    // Treasury / credit ETFs (Ondo).
    '13qTjKx53y6LKGGStiKeieGbnVx3fx1bbwopKFb3ondo', // iShares Core US Aggregate Bond ETF
    'KaSLSWByKy6b9FrCYXPEJoHmLpuFZtTCJk1F1Z9ondo', // iShares 20+ Year Treasury Bond ETF
    'o6U1Sm6Vd7EofMyCrL28mrp2QLzgYGgjveHiEQ5ondo', // WisdomTree Floating Rate Treasury Fund
    't71FyTYHVkPAb5g48adDHmkVxXYbUuP2eq6jDZLondo', // iShares AAA CLO Active ETF
    'ucQ3VfWAx9pkCN4Kg84zE56FtB4FJN2kQH4ArYYondo', // VanEck CLO ETF

    // Missing Birdeye token_overview symbol (these would show as "???" without filtering).
    '9DRPPWYud8i6CaSsDsFESs1xyVr8dBCMtjPZji2xiZEa',
    '7LWanZteUKtvFjv4MHYgKXXdAuCQYFPJysL9pxxdRQGn',
    '5d3zUSzje2saHwgzwJwFE8SDR8S5sGpE9wHhXdsCfu7j',
];

export const ETF_MINTS: readonly string[] = [
    // xStocks indexes / ETFs.
    'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', // Nasdaq
    'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', // SP500
    'XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc', // TQQQ
    'XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3', // Russell 2000
    'XsFnZawJdLdXfBSEt5Vw29K5vdBiHotdPLjUPafpfHs', // Core MSCI EM
    'XsWAnFM77x6YvpdaZoos79R12o4Yj4r7EVkaTWddzhU', // Schwab Intl
    'XsssYEQjzxBCFgvYFFNuhJFBeHNdLWYeUSP8F45cDr9', // Vanguard
    'XsEdDDTcVGJU6nvdRdVnj53eKTrsCkvtrVfXGmUK68V', // Vanguard Total World
    'XsaQGz41BEQkS9xAB44uvUtuXcdLJAXEU1dogEzWMZ8', // Strategy PP Fixed
    'Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH', // Strategy PP Variable

    // Ondo ETFs.
    '916SDKz7y5ZcEZC9CtnQ5Djs1Y8Yv3UAPb6bak8ondo', // iShares MSCI Emerging Markets ETF
    'AbvryMGnaba9oADMZk8Vp2Av6MtczsncGyfWaC4ondo', // iShares MSCI EAFE ETF
    'C9J9vZ8N79GzzxFoRkPWCkGtMKU8akg4FhUk4r9ondo', // iShares Core MSCI EAFE ETF
    'cdVNL7wK8mf1UCDqM6zdrziRv4hmvqWhXeTcck2ondo', // iShares Core MSCI EAFE ETF
    'cfPLN9WXD2BTkbZhRZMVXPmVSiRo44hJWRtnaC8ondo', // iShares Core S&P MidCap ETF
    'CPWkMURVvcnX8hGjqCTb8i5LkzV3VSvyk7SeJi8ondo', // iShares Core S&P Total US Stock Market ETF
    'CqW2pd6dCPG9xKZfAsTovzDsMmAGKJSDBNcwM96ondo', // iShares Core S&P 500 ETF
    'dSHPFuMMjZqt7xDYGWrexXTSkdEZAiZngqymQF2ondo', // iShares Russell 1000 Growth ETF
    'dvj2kKFSyjpnyYSYppgFdAEVfgjMEoQGi9VaV23ondo', // iShares Russell 2000 ETF
    'DX7g7WNjDpVzNK9CG81v7wb6ZbiNzYfkdzH2Xs5ondo', // iShares Russell 2000 Value ETF
    'HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo', // Invesco QQQ
    'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo', // SPDR S&P 500 ETF
    'jCCU4GwukjNxAXJowG2S4KCrr5g6YyUB61WHYvGondo', // Vanguard Total Stock Market ETF
    'D1tu7Fnm3cCpKyyPXrqm5GXShPqMj7a2SEjjq9fondo', // ProShares UltraPro Short QQQ
    '14W1itEkV7k1W819mLSknFTaMmkCtPokbF2tRkPUondo', // ProShares UltraPro QQQ
];

export const STOCKS_MINTS: readonly string[] = [
    'XsHtf5RpxsQ7jeJ9ivNewouZKJHbPxhPoEy6yYvULr7', // Abbott
    'XswbinNKyPmzTa5CskMbCPvMW6G5CMnZXZEeQSSQoie', // AbbVie
    'Xs5UJzmCRQ8DWZjskExdSQDnbE6iLkRu2jjrRAB1JSU', // Accenture
    'XsDZMGEU8zadWFCkTtPBoPWYcUX3JHVmghnwf2Mve2q', // Adobe
    'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', // Alphabet
    'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', // Amazon
    'XsaQTCgebC2KPbf27KUhdv5JFvHhQ4GDAPURwrEhAzb', // Amber
    'XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF', // AMD
    'XstYR6KGqZFchAuhHoEe4mL8W2kL9aqGW1EDBKRrmGB', // American Express
    'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', // Apple
    'XsPdAVBi8Zc1xvv53k4JcMrQaEDTgkGqKYeh7AYgPHV', // AppLovin
    'XshuHQ6o6SVpUNawvnnTMxsZ4tacZsNgVCLorv7TkFq', // ASML
    'Xs3ZFkPYT2BN7qBMqf1j1bfTeTm1rFzEFSsQ1z3wAKU', // AstraZeneca
    'XsR4LAtaBgTKTRUhiijY1ba13nx4bepeEcag2Pr4dZ1', // AST SpaceMobile
    'XsqML71RLbyUM3CmY4EYN88zE6BJkpvJACnUKBdGD3x', // AT&T
    'XswsQk4duEQmCbGzfqUUWYmi7pV7xpJ9eEmLHXCaEQP', // Bank of America
    'Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x', // Berkshire Hathaway
    'XsYMHtwJcWon5GkPHzdDbCCztKtKzEurJnbydxgjsqS', // Bending Spoons
    'XsPLBFy59Q3hY59KLAJur8QyvziMF4xUxGTxXqXE7cT', // Bit Digital
    'XsHt1AVPshZpfFWGGpooJ8tdeGknUQVJ9CwhvKrnZrw', // BitFuFu
    'XsrBCwaH8c46xiqXBChzobgufRKxQxAWUWbndgBNzFn', // Bitmine
    'Xs5ywCCaayf3TFdxFxuJCr25XMoqY6vdfJKkSHE4D6r', // BlackRock
    'XseQvfvuDT3KHKiwPNW1gcjfHbFjEMVTV5NJzDdNQmu', // Booking
    'XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo', // Broadcom
    'XsRiRZg9NGkL3WEZZmqnxvxEoyeHG8LhgzMQF2HRE6F', // Bullish
    'XsNNMt7WTNA2sV3jrb1NNfNgapxRF5i4i6GcnTRRHts', // Chevron
    'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', // Circle
    'Xsr3pdLQyXvDJBFgpR5nexCEZwXvigb8wbPYp4YoNFf', // Cisco
    'Xsn3H7ACEpSF2ULxeiD6kW4jRZXpurh8ZPttyfoS56W', // CleanSpark
    'XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ', // Coca-Cola
    'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', // Coinbase
    'XsvKCaNsxg2GN8jjUmq71qukMJr7Q1c5R2Mk9P8kcS8', // Comcast
    'XsBGEXxbBcuu8Nrokj14G8v4ezT3JYWWLneTzXK8t6Z', // Core Scientific
    'XsiRaD8qZm1P3KViowDYFS8rZ8BYT2g7ZEeyztthRye', // Costco
    'Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw', // CrowdStrike
    'Xseo8tgCZfkHxWS9xbFYeKFyMSbWEvZGFV1Gh53GtCV', // Danaher
    'Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy', // DeFi Development
    'Xs1CqRVt2mGVfMSHf7M6cDhkjpw8HDF14XbQNzDnGg4', // Duolingo
    'XsDYSbgLh3T7oh59UmRX1F5WjDgJD3nmzACaG5LR1MB', // eBay
    'Xsnuv4omNoHozR6EEW5mXkw8Nrny5rB3jVfLqi6gKMH', // Eli Lilly
    'XsFj75v4Tw8TWSDaDoVTHF8RAjEEkmUeKgoRjB9DHsf', // Expedia
    'XsaHND8sHyfMfsWPj6kSdd5VwvCayZvjYgKmmcNL5qh', // Exxon Mobil
    'XssfYT48PeXG2EmNdEaVtQcveNhxYnM42KTqdjmiBS9', // Figma
    'Xs3c2aZenyRQwXjki5MDxJEJ2km27ef2rWQMFWx7QKJ', // Galaxy Digital
    'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', // GameStop
    'XsgaUyp4jd1fNBCxgtTKkW64xnnhQcvgaxzsbAq5ZD1', // Goldman Sachs
    'XsicTFC7G68d74FaYDctWggkKDgkMx8LpNoFNr81TrF', // Helius Medical
    'XszjVtyhowGjSC5odCqBpW1CtXXwXjYokymrk7fGKD3', // Home Depot
    'XsRbLZthfABAPAfumWNEJhPyiKDW6TvDVeAeW7oKqA2', // Honeywell
    'XsG5QyZTQnVSpsXRpD92K5ZGoxXjsmfTyx7fW7r18DV', // Hut 8
    'XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM', // Intel
    'iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF', // Intel (Backpack Securities)
    'XspwhyYPdWVM8XBHZnpS9hgyag9MKjLRyE3tVfmCbSr', // IBM
    'XsGVi5eo1Dh2zUpic4qACcjuWGjNv8GCt3dm5XcX6Dn', // Johnson & Johnson
    'XsMAqkcKsUewDrzVkait4e5u4y8REgtyS7jWgCpLV2C', // JPMorgan Chase
    'XsSr8anD1hkvNMu8XQiVcmiaTP7XGvYu7Q58LdmtE8Z', // Linde
    'XsDmtC5EpfzJoCzDN2SJP98xpCsSR2CqdZauJSvHNXT', // Lululemon
    'XsguBZPkM9BDmxspmWe29EmrYZBv21ENcC27Pqh7grB', // MARA
    'XsuxRGDzbLjnJ72v74b7p9VY6N66uYgTCyfwwRjVCJA', // Marvell
    'XsApJFV9MAktqnAc6jqzsHVujxkGm9xcSUffaBoYLKC', // Mastercard
    'XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2', // McDonald's
    'XsDgw22qRLTv5Uwuzn6T63cW69exG41T6gwQhEK22u2', // Medtronic
    'XsnQnU7AdbRZYe2akqqpibDdXjkieGFfSkbkjX1Sd1X', // Merck
    'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', // Meta
    'XsQLZycSZ7QnBBdBXQaTbQdiUcbRqjNJgyBGAMzhHav', // Micron
    'MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1', // Micron (Backpack Securities)
    'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', // Microsoft
    'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', // MicroStrategy
    'MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz', // MicroStrategy (Backpack Securities)
    'MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT', // Moderna (Backpack Securities)
    'XsyusqQvb8RDULsY9szwvUv2CxrDKa642w7kecZPdRM', // Monster
    'NBiSF3UaVUFtRzHwAfxyHsBCAZWGEKnMpewAE4oh7BG', // Nebius Group (Backpack Securities)
    'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL', // Netflix
    'XsfAzPzYrYjd4Dpa9BU3cusBsvWfVB9gBcyGC87S57n', // Novo Nordisk
    'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', // NVIDIA
    'XsJb1p4Ks6VFggq68JyMz7S3kdRfkqh4wA6EMyxi4DD', // Oklo
    'XsGtpmjhmC8kyjVSWL4VicGu36ceq9u55PTgF8bhGv6', // OPEN
    'XsjFwUPiLofddX5cWFHW35GCbXcSu1BCUGfxoQAQjeL', // Oracle
    'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', // Palantir
    'XsQ6NfzzLH8nspjrB9X8R2K64Zz7Tnxqu12juDiMPMW', // Palo Alto Networks
    'XshWQWYVp5ff8CrAEsGmLVKD47nBWi3Ygn5v8wXK27G', // PayPal
    'Xsv99frTRUeornyvCfvhnDesQDWuvns1M852Pez91vF', // PepsiCo
    'XsAtbqkAP1HJxy7hFDeq7ok6yM43DQ9mQ1Rh861X8rw', // Pfizer
    'Xsba6tUnSjDae2VcopDB6FGGDaxRrewFCDa5hKn5vT3', // Philip Morris
    'XsMJtFbb8BwzQtck3oRXyAfs7SAPRuTXnSEDNd7BAVz', // Planet Labs
    'XsYdjDjNUygZ7yGKfQaB6TxLh2gC6RRjzLtLAGJrhzV', // Procter & Gamble
    'Xs31mE5EiqjSHEaiX9QDKCN6NvSGCqpJ6f1FNq2wri5', // Riot Platforms
    'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', // Robinhood
    'HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A', // Robinhood (Backpack Securities)
    'Xss5RAku5EH6UViFdvW7ss9xQjwQLsrs2opPMhb3k43', // Roblox
    'XsKSh3QDynp6oms9yHjZXbZo3pKzUBoqUFKPHS2g9Bh', // Rocket Lab
    'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw', // Roundhill Memory ETF (Backpack Securities)
    'XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN', // Salesforce
    'SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH', // SanDisk (Backpack Securities)
    'XsEoih2x6nZuUjFwzGoba6MFmtzCkzW2c4YAm6baQbq', // SharpLink Gaming
    'SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3', // SK Hynix (Backpack Securities)
    'Huyb2fyDDjSuDKCRWsN9ci2rmcgPo6NFiLbx9ZDondo', // SK Hynix (Ondo Tokenized)
    'XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU', // SK Hynix (xStock)
    'XsTuW2zaiPbzgrnQ7b4Z99zeULMM7gPxppE61CtpyDj', // S&P Global
    'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo', // Take-Two Interactive (Backpack Securities)
    'XsjXR5jf4d4GNpJXwLvEBTMwK3ZYro2qZGgvUCzyJrx', // Target
    'XsBgbNRDujfznQq8P4NLKEkRTbPxUVt4v1xwkDzMMtQ', // Tempus AI
    'XsuwUbQSzCJN2wZabD1Gxf1MER2Ypa7hMzVMYB2WawJ', // TeraWulf
    'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', // Tesla
    'Xs8drBWy3Sd5QY3aifG9kt9KFs2K3PGZmx7jWrsrk57', // Thermo Fisher
    'XswCi2U1G6Ppbw1QhG45yKb8UKuR1FKLJrquv2FZSD4', // T-Mobile
    'XscE4GUcsYhcyZu5ATiGUMmhxYa1D5fwbpJw4K6K4dp', // TON
    // 'XsRrH4fDA27xfyDjpcwefvcBdHCXs34krUuaXGEXzqz', // Tron
    'XsafvsGtzFqqHgTnA3aPC83EAMkacU5mcGtcSayhpVV', // TSMC
    'XsAsZLF4MmsvS1sDxRMrUz7REjHfwbC9UAMXSRBqgEB', // Uber
    'XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe', // UnitedHealth
    'Xsgrm4D6VBTfDx5bs7GNdjtmWDgZ8V79r3YpsYwf5py', // Virgin Galactic
    'XsqgsbXwWogGJsNcVZ3TyVouy2MbTkfCFhCGGGcQZ2p', // Visa
    'Xs936JPaWKEXmpu54DZ149GETV7PmsnTqnMWxgcPNAj', // Vistra
    'Xs151QeqTCiuKtinzfRATnUESM2xTU6V9Wy8Vy538ci', // Walmart
    'XsZUSqxAXKJkEimvD4CoVvEb4WUC92TFgj5zRtBxFeL', // Warner Bros
    'Xs4uNhvBDAcp2mz3g9XR5q3vzLgmF1ANWxJgWk2d5u3', // Wendy's

    //ONDO
    '123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo', // Apple
    '128qNYovdGv2YqayErcJgU7gDwbNVX1VuoxbtWz8ondo', // Airbnb
    '129gRoHKhVg7CvPMrqVsEB4uYZo6zV4yDZX6NBg9ondo', // Abbott
    '12LxMMJYVSf4LoeqjFE47BQQNRciaH9E3nbDfjH4ondo', // Accenture
    '12Rh6JhfW4X5fKP16bbUdb4pcVCKDHFB48x8GG33ondo', // Adobe
    '14diAn5z8kjrKwSC8WLqvBqqe5YmihJhjxRxd8Z6ondo', // AMD
    '14Tqdo8V1FhzKsE3W2pFsZCzYPQxxupXRcqw9jv6ondo', // Amazon
    '14VXAhoa1R74vi1ZuiQyGLJrnDMfoFBPJSCpGVz3ondo', // Apollo Global Management
    '14Z8rQQe2Aza33YgEUmj3g3QGNz8DXLiFPuCnsD1ondo', // AppLovin
    '15SsCZqCsM9fZGhTmP4rdJTPT9WGZKazDSsgeQ8ondo', // Arm Holdings plc
    '1eLZPRsn8bAKmoxsqDMH9Q2m2k7GMNp6RLSQGm8ondo', // ASML Holding NV
    '1FWZtdWN7y38BSXGzbs8D6Shk88oL9atDNgbVz9ondo', // Broadcom
    '1WxT6NdK7uqpfXuKpALxL2n3f7Rq61XXeHA8UM4ondo', // American Express
    '1zvb9ELBFShBCWKEk5jRTJAaPAwtVt7quEXx1X4ondo', // Alibaba
    '1YVZ4LGpq8CAhpdpm3mgy7GgPb83gJczCpxLUQ3ondo', // Boeing
    '54CoRF2FYMZNJg9tS36xq5BUcLZ7rju1r59jGc2ondo', // Baidu
    '5H1VpMzRuoNtRbPTRCz35ETtEUtnkt8hJuQb9v7ondo', // Blackrock, Inc.
    '5owVsVFSHACQuippFYdLp3qWRobp2EGcwxMmsr6ondo', // Chipotle
    '5u6KDiNJXxX4rGMfYT4BApZQC5CuDNrG6MHkwp1ondo', // Coinbase
    '6btaz134wjHkR8sqhAYrtSM6tavftfxnRvnyMd8ondo', // Costco
    '6xHEyem9hmkGtVq6XGCiQUGpPsHBaoYuYdFNZa5ondo', // Circle Internet Group
    '7D7ukbcnUNYt7Et5vtsDZhAy28MKu9pkHka1Hp9ondo', // Salesforce
    '7DWcZE1uVc8m2mf9pV8KNov28ET7HsvHkhrhgr9ondo', // Cisco Systems
    '7tgKziACteG26VjV5xKufojKxwTgCFyTwmWUmz5ondo', // Chevron
    '83P1gCFBZfGRCwJuBt9juxJKEsZwejJoG66eTZ6ondo', // DoorDash
    'mJf1xT3suXtkXBCfZcE9oUUuyxkvSgqYBWiX7v1ondo', // Disney
    'aheEdmuryJU8ymy8LjYheZH5i2BW1UMsfuWQKD2ondo', // Equinix
    'aLDdFsr3VTUQaHFK6yNvQxztvxQ8nxW4AMuSGC7ondo', // Figma, Inc
    'Ao5rKFRQ54W3DKSAtqfhBRPNHewwWRLNLao2JL9ondo', // Futu Holdings
    'aTBfDuLRqYHBiG82bHA7DzwjSDTFre2dRtGH3S5ondo', // General Electric
    'aznKt8v32CwYMEcTcB4bGTv8DXWStCpHrcCtyy7ondo', // GameStop
    'bbahNA5vT9WJeYft8tALrH1LXWffjwqVoUbqYa1ondo', // Alphabet Class A
    'BchJRy2snmhJZf3rQ9LJ3ePs2BGfYgfvQNo31d2ondo', // Goldman Sachs
    'bdh3njeo19d2TBLAKTGvCWdSoArfVw8uZBAJHY4ondo', // Hims & Hers Health
    'BVdXGvmgi6A9oAiwWvBvP76fyTqcCNRJMM7zMN6ondo', // Robinhood Markets
    'C8bZkgSxXkyT1RgxByp2teJ24hgimPLoyEYoNa9ondo', // IBM
    'cJpUMp5R7rZ6fGeLHbHhrRuJzK9mkyKDjZqNpT3ondo', // Intel
    'CozoH5HBTyyeYSQxHcWpGzd4Sq5XBaKzBzvTtN3ondo', // Intuit
    'E1aUS5nyv7kaBzdQzPVJW5zfaMgoUJpKYzdnFS2ondo', // JD.com
    'E5Gczsavxcomqf6Cw1sGCKLabL1xYD2FzKxVoB4ondo', // JPMorgan Chase
    'e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo', // Coca-Cola
    'Edik9MoFp8LAXS9HNu2gRFyihwYqDqv4ZmNmVT9ondo', // Linde plc
    'eGGxZwNSfuNKRqQLKaz2hc4QkA2mau7skyxPdj7ondo', // Eli Lilly
    'EoReHwUnGGekbXFHLj5rbCVKiwWqu32GrETMfw4ondo', // Lockheed
    'EsVHcyRxXFJCLMiuYLWhoDygrNe1BJGpYeZ17X7ondo', // Mastercard
    'ETCJUmuhs5aY62xgEVWCZ5JR8KPdeXUaJz3LuC5ondo', // MARA Holdings
    'EUbJjmDt8JA222M91bVLZs211siZ2jzbFArH9N3ondo', // McDonald's
    'EWwdgGshGngcMpDV34pWZRSu5bkAuiKuKTTHKQ8ondo', // MercadoLibre
    'fDxs5y12E7x7jBwCKBXGqt71uJmCWsAQ3Srkte6ondo', // Meta Platforms
    'FovBwhoV5KQjZCdhoM6jgXYwXLX3F8vgAfvmLH7ondo', // Marvell Technology
    'FRmH6iRkMr33DLG6zVLR7EM4LojBFAuq6NtFzG6ondo', // Microsoft
    'FSz4ouiqXpHuGPcpacZfTzbMjScoj5FfzHkiyu2ondo', // MicroStrategy
    'Fz9edBpaURPPzpKVRR1A8PENYDEgHqwx5D5th28ondo', // Micron Technology
    'g4KnPrxPLeeKkwvDmZFMtYQPM64eHeShbD55vK6ondo', // Netflix
    'g646pcdG2Rt5DH9WZzL7VVnVDWCCMTTrnktwE74ondo', // Nike
    'G7pTVoSECz5RQWubEnTP7AC83KHUsSyoiqYR1R2ondo', // ServiceNow
    'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo', // NVIDIA
    'hM7B3UQTTR81mS27SxDDPzBbjejmo8fnpFjzgv9ondo', // PayPal
    'hqJXutLF6f7DxStrWCrnZDfXzbNTZmvi3KheVi6ondo', // D-Wave Quantum
    'hrmX7MV5hifoaBVjnrdpz698yABxrbBNAcWtWo9ondo', // Qualcomm
    'HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo', // Invesco QQQ
    'HXFrTf9v9NdjGUTnx4sojR3Cf92hoBsQFUxKTN7ondo', // Reddit
    'i6f3DvZBuLpnGSqS8x6WPeStJ7jNe5KewD6afD5ondo', // Riot Platforms
    'iLDu2jjp2i3Uqc2Vm7K7GLiUj3hR4Un49MtD7c4ondo', // SharpLink Gaming, Inc
    'iPFqjcZQTNMNXA4kbShbMhfAVD8yr8Uq9UtXMV6ondo', // Starbucks
    'ivdDracs2s7jCP698dJXKSEQdVrNj9hasJL1Uq1ondo', // Shopify
    'jLca79XzcewRuBZyaJxVxuKpUHcEix1X4CP1RP9ondo', // Super Micro Computer
    'KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo', // Tesla
    'keybg184d4vyXeQdFqs4o99YsMg7xBthxTJ6Ky3ondo', // Taiwan Semiconductor Manufacturing
    'AErxJJxGbc9cZzZoZepN62BNfg5RXns8tmEc3Zpondo', // Caterpillar
    '7NWHifsBnn9DimUeNnsHdEXkTZhXmJTiXxcCngBondo', // Constellation Energy
    'WNZBSkNBNP3Ct1pcFn6Fu4sZQFhnu48EsM9voCEondo', // Cipher Mining
    'ucQ3VfWAx9pkCN4Kg84zE56FtB4FJN2kQH4ArYYondo', // VanEck CLO ETF
    'R2uDbMtmHq5xSS5SserrovdRKdpiqnVBCd2AHLhondo', // Capital One
    'PjtfUiw6Hwd8PZ94EcUw8mBSYxp7SjjzSLeNTDKondo', // Citigroup
    'cdKfoNjbXgnSuxvoajhtH3uixfZhq1YXhQsS1Rwondo', // CrowdStrike
    'ZmHxc6Gt27RJKxD2ay6UL4n9yQ7mKAq4XZQUeVhondo', // Figure Technology Solutions
    '5hT2o25X9tGXipwhLckaUdgnxrZ6Y8eiUwdhpLeondo', // Ford Motor
    'KUXt7LzHWSQXp5eyqMZRxWjAP6yM8BUh4LRHwiwondo', // Johnson & Johnson
    '13qtwy5fZi9Przz14pzo9xqFSr8QHmLyUpUCvP1xondo', // ON Semiconductor
    'mqL8yXQpeSvc7NgrAtLLPtRvUiWyLoG5RWLv16iondo', // SoFi Technologies
    'aKzjn2ZdWySSGPSSDTY2HUpcSCmemSahTXihrpyondo', // Southern
    '9PMjLqd8zPdKkJUXarnit5t7tPL3cCscwHzy7ATondo', // Trip.com Group
    'RTb54gpqAx6RpLAHRGnqQ3ciQ845CHqhg21ZzEJondo', // Talen Energy
    'T699bgtXQw4CJ59rQ4VzLsupVQUzoL5RmuhHnKrondo', // Thermo Fisher Scientific
    'pDY4GPJfZcNETPG7myXeafQfgJqqVkn81bMYDyfondo', // T-Mobile US
    'WKMZummev5UcXz5nNKQZvTD6QjNSM2X58uwmDReondo', // AT&T
    'o6U1Sm6Vd7EofMyCrL28mrp2QLzgYGgjveHiEQ5ondo', // WisdomTree Floating Rate Treasury Fund
    'c5ug15fwZRfQhhVa6LHscFY33ebVDHcVCezYpj7ondo', // iBoxx $ High Yield Corporate Bond ETF
    'GeV7S8vjP8qdYZpdGv2Xi6e7MUMCk8NAAp2z7g5ondo', // Novo Nordisk
    'GmDADFpfwjfzZq9MfCafMDTS69MgVjtzD7Fd9a4ondo', // Oracle
    'M7hVQomhw4Q2D2op3HvBrZjHu9SryjNvD5haEZ1ondo', // Palo Alto Networks
    'GRciFCqJ5y2hbiD6U5mGkohY65BZTXGuGUrCqf7ondo', // Petrobras
    'gud6b3fYekjhMG5F818BALwbg2vt4JKoow59Md9ondo', // PepsiCo
    'Gwh9fPsX1qWATXy63vNaJnAFfwebWQtZaVmPko6ondo', // Pfizer
    'GZ8v4NdSG7CTRZqHMgNsTPRULeVi8CpdWd9wZY8ondo', // Procter & Gamble
    'HfsnTS5qtdStwec9DfBrunRqnAMYMMz1kjv9Hu9ondo', // Palantir Technologies
    'JmFLCBwoNvcXy6B2VqABg6m784ubkXpaEx3p7S5ondo', // Snowflake
    'JrTYw7A9jihX5TwpRStYviEbsYf2X2VJpZ13719ondo', // S&P Global
    'jzCvs2Pk8tDcfsFRqnEMjurgaQW4iQfEkandUR8ondo', // Spotify
    'k6BPp2Xmf2TYgrZiUyWfUoZBKeqaDbvPoAVgSx2ondo', // iShares TIPS Bond ETF
    'kbmF7ERJWMaaDswMprrH9gHSLya5D2RMBNgKqg3ondo', // Toyota
    'KJNeFW3kk3ycPjXpC6cbuyckjeYHacc2ekhtAi5ondo', // Uber
    'kPBGL8vAwKN3UGmr9cjkM2dU79SC3nzTC9yu7F8ondo', // UnitedHealth
    'kxEW4oJL75K37VeXaZF1ynbHQATQwhECQKN1374ondo', // Visa
    'L6ZE5qCpVVSqLePz64CrwkgyWoPF9M7tB8BeFH4ondo', // Wells Fargo
    'LZddqAqKqJW9oMZSjTxCUmbmzBRQtv9gMkD9hZ3ondo', // Walmart
    '9wYZetvT8J2ptfsRca5gzLBGvcUug38mp9yT3xaondo', // American Airlines Group
    'MFerpBVGKZh2jXN7cbJdXRXQTp6j6pbSnSZrfWrondo', // AbbVie
    'KcCVQxG9LhFYP5o9DWFKTFgFShPPQkDEemVbiFyondo', // Archer Aviation
    'LmTMwmZLNZszn3qpjmnbhfP12U4qWDivaEBwSBSondo', // Analog Devices
    '7eRX747PSbVtGVx3qD5UFdkNM2BfTy86ikUiCMhondo', // Applied Materials
    'C9xNaNujcF1a5fidWAAFReFYqhLRVbyk4yPyGqzondo', // AMC Entertainment
    'SS6AEWhzRrxhL2cXzKKjhFt3rCzmHHGKmFyugDTondo', // Amgen
    'Cq6QtvHpXbJWtFaiMhUDtHy8YVZ95gcD1oZ1cohondo', // Arista Networks
    'Wk8gC6iTNp8dqd4ghkJ3h1giiUnyhykwHh7tYWjondo', // Bank of America
    'YXE7mph6XhsgnyezkMEcTuohSuWhbLWfwx2Hh6mondo', // BigBear.ai Holdings
    '14kLsQVmc64qZexYuR4XGop9y8BeMkd77pJUm1Rhondo', // Bilibili
    'mhZ69E1vDnAsQJXAwarLYSX5tmgeMajXBJ2rXAcondo', // iShares Flexible Income Active ETF
    'A9PFmw9Hu8zzxDUoU351pio1E1XWBWBfWnjT9qoondo', // Bullish
    'MYXqkDYbzr7vjXAz2BapR4AiYRXzoikGirrLoRzondo', // BitMine Immersion Technologies
    'cBnVXDyZgaaLZM18wAmqsUKnRUFAEJWbq6VuUoaondo', // B2Gold
    'doPqjCxi6UkANkvMz5fSuYGEo5PGppVpTZMeB5vondo', // Kanzhun
    'X68p9qTpEMkR1TLpXUP2ZJo8PG4Qge2Y2ZLdjA2ondo', // ConocoPhillips
    'NKyzy31w2J7odLb2CW3Ft4fpKXkW3LBt1pvpkVLondo', // Coupang
    'FGmUDXqA3AbWfo5b3NUcsvwoUFCF4tr9ea6uercondo', // Carvana
    'td1aY5AvYQuwGD75qNq9aPipMexraN9mQXJwqifondo', // Invesco DB Commodity Index Tracking Fund
    'CqQyAZjB9LGFTG95eiadGTkfhd9QA12ProeKsQmondo', // Deere
    'gnoSQSNTNZHViqVfxCcPDVxcRA29mrJL7C6JqYLondo', // WisdomTree US Quality Dividend Growth Fund
    '12J2LD3tuLfdiVKnWZMHRMrbnXDY9rM4yqVLUa5yondo', // Denison Mines
    'ivBnfPTyuHDNWmMSnbavckhJK6SHZW8h77nZKsEondo', // First Trust Global Tactical Commodity Strategy Fund
    'NrTdGMA3ujUvWXkwXyZKnhoByb32KTjRh5Vo47yondo', // Gemini Space Station
    'm9GcsVgdjaL3KsdtSFHimnhtsUMpTHkjtwEG4Tzondo', // Grab Holdings
    'Gc1aT3ay7FXL3qdAW7cNSXYPDsGavy7qiACuxwxondo', // Grindr
    'MtEXKVN3Pcggy8MPA3eJr15H6SK3RXheScqj9qtondo', // Home Depot
    '13QHuepdhtJ3urNsV9i1hdL8nQoca2G7ZaLzb5FYondo', // IREN
    '1MGRpPrkhEsCm2GCWD3rsvEU77xTTLAzfKXeFgFondo', // Intuitive Surgical
    'KZtqx9BJbpcGY7vdzhqPXM3ECKChxE5YhXaDiwRondo', // Janus Henderson AAA CLO ETF
    '149o8ppQf9SzKCKXZ4v3dzHkwumvtQSRzSEkr29uondo', // KLA
    'v12TwfofSbvVqQ5N5KGG4d3J8rtEi4BjGfn2apyondo', // Li Auto
    'edLdFJVVR532qhcrNTJjLAmhmyV7NsctbWVokMBondo', // Lowe's
    'wFJoeEYpKg9oRhyJy6BWTT3J95gmXBLvoeikDQNondo', // Lam Research
    'XwFm5GiKPVTvPiEbQpdc6vJbFEpsUXRMf6TcSxnondo', // MP Materials
    'bn1fb8dwzafGePqNPrM8m8cbAKQiFqeEPuZkPySondo', // Merck
    '14VP7DvCAdBCc5XGNZkPt6zhtPzJrWWS64Koxtxyondo', // Moderna
    'R3ywbVQ5t8LNmjQsn2Ngv43dSqyZscQwNag9G3Eondo', // MasTec
    't7eN6cGwRMFaZvsNW2SmVwkedmHtDdrxA4ycNE5ondo', // NextEra Energy
    'V8LRV7kWjrx6Prke9oHEHNUiR122BVtyuPciTCTondo', // Sprott Nickel Miners ETF
    'yQ37dFiGAbzrb2FRAEhGNzRy5zFfoYGWYhAepFEondo', // NIO
    'YeK2TdPtGLAme3Phg4pb1GBN2YxKgX5UNVyD4asondo', // NetEase
    'm6oDLvJT7rY7M1TxuLWP3pWmAPg2cCWDQR1NKiEondo', // Oklo
    '7qy1j4Mechfyr6uAST3djH4vk4kiEYC2cjEytXdondo', // Ondas Holdings
    'ou1uE526v7zmUYP2qCb2LJgfXAyWAtWS9SETtr8ondo', // Opendoor Technologies
    'gbHFTMkuMQUy5xrgoCBdaQ2XYvNyjWAYcnRPh9Condo', // Opera
    'ThwGDsXZ6iKubWuEQjmDxGwF3bUERDGbBXvcbjFondo', // Oscar Health
    '1GNFMryQ6c9ZpMhgNimmsbtgYM21qnBJgRAFoNiondo', // Occidental Petroleum
    'P7hTXnKk2d2DyqWnefp5BSroE1qjjKpKxg9SxQqondo', // abrdn Physical Palladium Shares ETF
    'UP5s1srLaHDc4SwJqLPa3A48x5R7ofN3hZWxWEZondo', // PG&E
    'M6agiXbNgy8Xon9ngiW4ZDPbMFcNCTMkMMkshZyondo', // Invesco Optimum Yld Dvsfd Cmd Str No K-1 ETF
    'PnjETBCLC318DRejo9cMQKAmET9PvW8AEFGWMNtondo', // PDD Holdings
    'sxyg1VTSzy5zYANUK7hntNtmFAWoXGJq95AcHuVondo', // Pinterest
    'TnfswqdE1jAJ8sfnf5J7kSVLEH1cfpAYZ8MWmKfondo', // Plug Power
    'qKtU9A7ij34XmtxaSzYfxCpkgAZzzFsqnUb2kW2ondo', // ProShares Short QQQ
    'tiitb2Z1HtpB2DpVr6V7tdCFS3jmTinLeuGj9EVondo', // VanEck Rare Earth and Strategic Metals ETF
    'dwEPNKQab3iwRmjGvZPXhAmws1W5NsQGwuXwi8oondo', // Rigetti Computing
    'AXRsYFt7TXNQ3DcY6BkvRgPV6VsYMURyDtaeudjondo', // Rivian Automotive
    '12BvLZtzjdssAycxPeBQUjukhmgQpULAvy6SroYdondo', // RTX
    'cnc6M1zXLdrGR5LAQVcaJDfgezMiVWNtGQsVy1Kondo', // Charles Schwab
    'HjrN6ChZK2QRL6hMXayjGPLFvxhgjwKEy135VRjondo', // iShares 0-3 Month Treasury Bond ETF
    'a2cXfonVgQ6cKB4Lm8YZsPry39VZSA562bwmRSiondo', // Snap
    'vE2qArmjto6VfeMngyGAnzp2ipLYeXsxiARDnnXondo', // SoundHound AI
    '81xLFvCzFaUM3KDxSHC75pXu3RPCeSeCbmGBY8aondo', // Texas Instruments
    'rpydAzWdCy85HEmoQkH5PVxYtDYQWjmLxgHHadxondo', // United States Oil Fund
    'MkN2TZSYTFBdMRLf9EVcfhstTwnazH8knd9hpepondo', // Vertiv
    'h6MW8GFpfzxFa1JNn6hZNnBF3t4fj9SHAXKy6LXondo', // Vistra
    'KuiYLPVq65qixD9TgvxBC576C4gG6vVTCdbh2zFondo', // Vanguard Value ETF
    'igu1coP6n3GPaWmbd8J9Z7UAyLpV254uQFFNfydondo', // Verizon
    'exYfSJt6Fgfhfnp3bAD4roYy97hLF9npjYaLyEXondo', // Terawulf
    'qCYD74QnXzd9pzv6pGHQKJVwoibL6sNcPQDnpDiondo', // Exxon Mobil
    'BWxe2FVciUbwrCUZQPUKiREBh5LmVa5AiUqNLAkondo', // Block

    // SpaceX primary variants.
    'wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo',
    'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb',
    'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8',

    // Pre* mints (added).
    'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF',
    'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ', // T-OpenAI (Tessera)
    'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw',
    'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB',
    'Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP',
    'PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua',
    'PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx', // xAI (PreStocks)
    'y6kSRF4i9tfMMjZziPHtQE1PeUS6bWEHTzZMFgXondo', // STRCon

    // Ondo stocks batch (2026-06-18).
    ...ONDO_STOCK_MINTS_20260618,
];

export const METALS_MINTS: readonly string[] = [
    'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P', // Tether gold
    '9TPL8droGJ7jThsq4momaoz6uhTcvX2SeMqipoPmNa8R', // Gold/Silver token
    'GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A', // GOLD
    'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', // Gold
    '5aLhp9VnUEKcsdtkfsf2DUgpJfomx7GmYVny24dHUZoB', // Matrixdock Gold
    '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW', // PAX Gold
    'M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo', // iShares Gold Trust
    'iy11ytbSGcUnrjE6Lfv78TFqxKyUESfku1FugS9ondo', // iShares Silver Trust
    'hWfiw4mcxT8rnNFkk6fsCQSxoxgZ9yVhB6tyeVcondo', // SPDR Gold Shares
    'X7j77hTmjZJbepkXXBcsEapM8qNgdfihkFj6CZ5ondo', // Global X Copper Miners ETF
];
