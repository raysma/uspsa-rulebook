# rules.uspsa.org — Architecture Investigation

Goal: understand how the USPSA online rules get populated into the web app so we
can extract and cache that content ourselves for search/querying.

_Investigation date: 2026-06-17. At the time of investigation the site's data
backend was in a maintenance window (see "Current status" below), so live data
extraction was not possible. The architecture below was reconstructed from the
static landing page, the served HTML/RSC shells, and the JavaScript bundles._

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

## Recommended extraction approach (once the backend is back)

No headless browser required for the primary path:

1. **Capture the RSC flight payload** for each book and parse it:
   ```bash
   curl -s -H "RSC: 1" https://rules.uspsa.org/uspsa    > uspsa.rsc
   curl -s -H "RSC: 1" https://rules.uspsa.org/multigun > multigun.rsc
   curl -s -H "RSC: 1" https://rules.uspsa.org/scsa     > scsa.rsc
   ```
   When not in maintenance this should embed the full chapters/sections/rules
   tree. Parse the `__next_f` / flight stream into normalized JSON.
2. **Cross-check the bulk client payload** that feeds `localStorage["rules-pages"]`
   (inspect a browser/headless network trace) — likely a single JSON blob that
   is the cleanest source of truth.
3. **Normalize and index** as e.g. `{ book, chapter, section, ruleNumber, text }`
   into SQLite FTS (or an in-memory index) for our own search/query.
4. Use the official `/api/search?rs=<ts>&q=...` endpoint as a **validation
   oracle** to confirm our cached copy matches.

## Environment notes (this sandbox)

- Outbound HTTP works (reached `rules.uspsa.org`, Cloudflare, npm registry).
- A headless browser could **not** be installed here: Playwright's Chromium CDN
  download was blocked, and `--with-deps` failed on blocked apt PPAs. The
  RSC-flight `curl` approach above avoids needing a browser at all.
