# rules.uspsa.org — Architecture Investigation

Goal: understand how the USPSA online rules get populated into the web app so we
can extract and cache that content ourselves for search/querying.

_Investigation dates: 2026-06-17 → 2026-06-19. The site was first hit during a
data-backend maintenance window; once it came back up the architecture below was
confirmed and a working extractor was built (`scripts/extract.mjs`), producing
the cache in `data/`._

**Status: implemented.** The full content surface is mirrored to JSON:
**1,337 rules + 56 appendices + 40 glossary terms + 5 changelog entries**
(1,438 entries) across the three books, plus a **1,608-route manifest**
(`data/manifest.json`) enumerating every URL the site exposes.

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
- **Search API:** `GET /api/search?rs=<ruleset>&q=<query>` returns JSON.
  Called client-side with a ~140 ms debounce:
  ```js
  fetch(`/api/search?rs=${e}&q=${encodeURIComponent(t)}`, { signal: r.signal })
  ```
  `rs` selects the ruleset; empirically the book slug works
  (`rs=uspsa|multigun|scsa`). Missing/blank params return `[]` or HTTP 400.
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

## The full route surface

`<book>` is one of `uspsa`, `multigun`, `scsa`. Every **page** route returns its
structured content as an RSC flight payload (`Content-Type: text/x-component`)
when requested with the header `RSC: 1`; without it you get a hydration shell.
There is no `robots.txt` or `sitemap.xml` (both 404; pages carry `noindex`).

| Route                          | Returns                                                              |
|--------------------------------|---------------------------------------------------------------------|
| `/`                            | Static landing page linking to the three books                      |
| `/<book>`                      | Table of contents: `chapters[]`, `sectionsByChapter{}`, `appendices[]` |
| `/<book>/section/<number>`     | A section's rules (e.g. `5.6`)                                       |
| `/<book>/rule/<number>`        | A single rule's page (e.g. `5.6.1`) — duplicates section content     |
| `/<book>/appendix/<id>`        | An appendix (e.g. `C2` = Chronograph, `D1` = Open Division)          |
| `/<book>/glossary`             | Glossary — `{"term","content"}` term/definition pairs               |
| `/<book>/changelog`            | Board-approved rule changes (struck = removed, highlighted = added) |
| `/api/search?rs=<book>&q=<q>`  | JSON search results `{type,badge,title,snippet}` (snippets only)    |

`data/manifest.json` enumerates all 1,608 of these routes (1 home + per book:
landing, glossary, changelog, every section, every rule, every appendix).

## How content is encoded in the flight payload

The content appears in three shapes, all handled by the extractor:

1. **Clean rule data objects** — `{"number":"5.6.1","title":null,"text":"…"}`.
   Matched directly with a regex (the markup/element form starts
   `["$","div","5.6.1",{…}]` and is skipped). Authoritative for most numbered rules.
2. **Rendered `rule-prose` markup** — used for section-level prose (much of the
   SCSA book), multi-paragraph rules, appendices, and the changelog. The extractor
   walks the `rule-prose` blocks, strips attributes/element headers/object keys,
   and collects the readable text, keying each block to the nearest preceding
   rule-number badge (`bg-navy`/`bg-muted` mono span).
3. **Glossary objects** — `{"term":"…","content":[…prose…]}`. Term plus a
   definition rendered as `rule-prose`. The same definitions also appear inline
   throughout the rules as hover popovers.

For rules, passes 1 and 2 are merged (flat wins; prose fills missing rules and
null `text`). Output is normalized into `data/<book>.json` (hierarchical),
`data/rules-flat.json` (flat searchable index of all 1,438 entries), and
`data/manifest.json` (route inventory). The official `/api/search` endpoint was
used as a validation oracle to confirm wording matches.

Pieces explored but **not** used as the source of truth: the bulk client payload
behind `localStorage["rules-pages"]` (the per-route RSC payloads turned out to be
complete and simpler to parse), the `/<book>/rule/<n>` pages (they duplicate
section content), and `/api/search` (snippets only, no full text).

## Limitations

- **Glossary (Appendix `A3`)** is just a stub that points at `/<book>/glossary`;
  the real term/definition data comes from that route and is captured as the
  `glossary` type. The `A3` appendix entry therefore has empty text.
- **Appendix tables/diagrams** (target dimensions, division equipment grids) are
  captured as readable text; tabular layout and images are not preserved.
- The USPSA rulebook is **"evergreen"** (updated in place rather than versioned);
  re-run `scripts/extract.mjs` to refresh. The `rules-ts` value in `localStorage`
  is the ruleset timestamp the client uses for cache-busting and the `rs` search
  param.

## Environment notes (this sandbox)

- Outbound HTTP works (reached `rules.uspsa.org`, Cloudflare, npm registry).
- A headless browser could **not** be installed here: Playwright's Chromium CDN
  download was blocked, and `--with-deps` failed on blocked apt PPAs. The
  RSC-flight `curl` approach above avoids needing a browser at all.
