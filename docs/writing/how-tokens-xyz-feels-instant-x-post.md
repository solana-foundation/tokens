# X post: How tokens.xyz feels instant

Companion to `how-tokens-xyz-feels-instant.md`. Replace `[link]` with the published article URL.

## Short post (under 280 characters)

```
tokens.xyz is rendered from the same public API anyone can call with a key. Every visitor shares one key and one rate budget, so a wasted call costs everyone.

How it still feels instant: shell before data, proxy as CDN, one client cache, hover prefetch.

[link]
```

## Long post (X Premium)

```
tokens.xyz is rendered from the same public API anyone can call with a key. There is no private backdoor for the website. Every visitor shares one platform key with the same burst, sustained and provider budgets as a customer key.

So a wasted request is not just slow for one person. It spends a budget everyone shares.

Linear solved speed with a sync engine. That is the right answer for a write-heavy app. For a read-heavy data site it is the wrong tool, so we built a stack of caches instead, each with a lifetime that has a reason. The rule at every layer: before you fetch, ask who already has this.

What I wrote up:

- Ship the shell before the API is asked anything. The fallback is the real page minus the numbers, and route resolution never leaves the process.
- Cache the shape you serve, not the bytes you fetch. The heat map caches a 300 KB tree, not the 1.5 MB response, and never caches a failure.
- The proxy is the CDN. The API marks responses private because of the key header. The one layer that holds the key relabels them public with an s-maxage per path.
- One client cache, many readers. The price column reads the sparkline's query cache through useSyncExternalStore and never fetches.
- Fetch on intent. Sparklines wait for the viewport, rows prefetch on a 75 ms hover, and dense grids turn Link prefetch off.
- A cache in the wrong region is slower than no cache. A Redis hit on auth cost 62 ms; the lookup it fronted cost 12 to 16 ms. We deleted the cache.

Plus the honest list of what is still rough.

[link]
```

## Alternative hooks

1. `We deleted a cache and the API got faster. The Redis hit cost 62 ms; the lookup it was protecting cost 14 ms. That and eleven other things I learned making tokens.xyz feel instant on a rate-limited API: [link]`

2. `Every page on tokens.xyz is built from the same public API you can call with a key. One shared key, one shared rate budget. Here is how it still feels instant without a sync engine: [link]`

3. `Linear is fast because it moved the database into the browser. tokens.xyz is read-heavy, so we did something different: caches at every layer, each with a reason for its TTL, and one rule: ask who already has this. [link]`
