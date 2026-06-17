# rules.uspsa.org — Architecture Investigation

Goal: understand how the USPSA online rules get populated into the web app so we
can extract and cache that content ourselves for search/querying.

_Investigation date: 2026-06-17. The site was first hit during a data-backend
maintenance window; once it came back up the architecture below was confirmed
and a working extractor was built (`scripts/extract.mjs`), producing the cache
in `data/`. **Status: implemented — 1,337 rules + 56 appendices cached.**_

## Stack

- **Next.js App Router** with **React Server Components**, deployed on **Vercel**.
  - Evidence: `/_next/static/chunks/...` assets, Turbopack chunks, `dpl_...`
    deployment IDs, and the `self.__next_f.push([...])` RSC "flight" stream in
    the served HTML.
- **Tailwind CSS** for styling, **Radix UI** (settings dialog), **FontAwesome**
  icons.
- Static assets (logo, etc.) served from **`storage.uspsa.org`**
  (Cloudflare-fronted, GCS-style bucket).

## Site structure

A static landing page (`/`) links to three rulebooks:

| Path        | Rulebook                  |
|-------------|---------------------------|
| `/uspsa`    | USPSA Competition Rules   |
| `/multigun` | Multigun                  |
| `/scsa`     | Steel Challenge (SCSA)    |

## How the rules are populated (the key question)

- The **landing page is static**. The three **rulebook pages are dynamically
  server-rendered** and pull rule content from a data backend. The rule text is
  **not** in the static HTML — it is streamed into the RSC flight payload
  (`self.__next_f.push([...])`) and/or fetched client-side.
- **Data model: chapters -> sections -> rules.** The bundles reference
  `chapters:`, `section:`, and a `ruleset` concept.
- **Search API:** `GET /api/search?rs=<rulesetVersion>&q=<query>` returns JSON.
  Called client-side with a ~140 ms debounce:
  ```js
  fetch(`/api/search?rs=${e}&q=${encodeURIComponent(t)}`, { signal: r.signal })
  ```
  `rs` is the ruleset version/timestamp (see `rules-ts` below), **not** the book
  slug.
- **Client-side cache in `localStorage`** (set very early via a
  `beforeInteractive` script):
  - `rules-ts`   — ruleset timestamp / version (this is the `rs` param)
  - `rules-pages` — cached rule pages (implies the client downloads the whole
    rulebook as one bulk payload, then caches it)
  - `rules-share` — share/display preference
  The presence of `rules-pages` strongly suggests a **single bulk payload**
  containing the full rulebook — the ideal source of truth to cache.

## Current status (as of investigation)

The data backend was in **maintenance**, cascading into errors on every
data-backed page:

- `storage.uspsa.org` 307-redirects **everyone** (verified from two different
  IPs, not just our sandbox) to `https://maintenance.uspsa.io/`.
- Rulebook pages (`/uspsa`, `/multigun`, `/scsa`) return **HTTP 500** with
  server error `digest 1326680035`.
- `/api/search` returns `[]`.
- The static landing page (`/`) still returns **200**.

This is almost certainly transient. Re-check with:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rules.uspsa.org/uspsa
# 200 = back up, 500 = still in maintenance
```

## Extraction approach (implemented in `scripts/extract.mjs`)

No headless browser required — every request is a `curl`/`fetch` with the
`RSC: 1` header, which returns the React Flight payload as `text/x-component`.

Confirmed routes (all accept `RSC: 1`):

| Route                          | Returns                                                         |
|--------------------------------|----------------------------------------------------------------|
| `/<book>`                      | Table of contents: `chapters[]`, `sectionsByChapter{}`, `appendices[]` |
| `/<book>/section/<number>`     | A section's rules                                              |
| `/<book>/appendix/<id>`        | An appendix's content (e.g. `C2` = Chronograph, `D1` = Open Division) |
| `/api/search?rs=<book>&q=<q>`  | JSON search results `{type,badge,title,snippet}` (snippets only) |

`<book>` is one of `uspsa`, `multigun`, `scsa`.

The rule content appears in the flight payload in two forms, both handled by the
extractor:

1. **Clean data objects** — `{"number":"5.6.1","title":null,"text":"…"}`. Matched
   directly with a regex (the markup/element form starts `["$","div","5.6.1",{…}]`
   and is skipped). This is the authoritative source for most numbered rules.
2. **Rendered `rule-prose` markup** — used for section-level prose (much of the
   SCSA book), multi-paragraph rules, and appendices. The extractor walks the
   `rule-prose` blocks, strips attributes/element headers/object keys, and
   collects the readable text, keying each block to the nearest preceding
   rule-number badge (`bg-navy`/`bg-muted` mono span).

The two passes are merged (flat wins; prose fills missing rules and null `text`).
Output is normalized into `data/<book>.json` (hierarchical) and
`data/rules-flat.json` (flat index). The official `/api/search` endpoint was used
as a validation oracle to confirm wording matches.

Pieces explored but **not** used as the source of truth: the bulk client payload
behind `localStorage["rules-pages"]` (the per-route RSC payloads turned out to be
complete and simpler to parse), and the `/api/search` endpoint (snippets only, no
full text).

## Environment notes (this sandbox)

- Outbound HTTP works (reached `rules.uspsa.org`, Cloudflare, npm registry).
- A headless browser could **not** be installed here: Playwright's Chromium CDN
  download was blocked, and `--with-deps` failed on blocked apt PPAs. The
  RSC-flight `curl` approach above avoids needing a browser at all.
