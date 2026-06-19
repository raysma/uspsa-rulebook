# uspsa-rulebook

A local, queryable copy of the **entire content surface** of the official USPSA
competition rules site, [rules.uspsa.org](https://rules.uspsa.org) — the USPSA,
Multigun, and Steel Challenge (SCSA) rulebooks, extracted into plain JSON for
search and querying.

Covers every rule, appendix, glossary term, and changelog entry (1,438 entries),
plus a manifest of all 1,608 routes the site exposes.

See [`INVESTIGATION.md`](INVESTIGATION.md) for how the source site is built and
how the extraction works.

## What's here

```
scripts/extract.mjs   Pull the entire surface from rules.uspsa.org into data/
scripts/search.mjs    Search the cache (no dependencies)
data/uspsa.json       USPSA — chapters → sections → rules, + appendices, glossary, changelog
data/multigun.json    Multigun — same shape
data/scsa.json        Steel Challenge — same shape
data/rules-flat.json  Every rule/appendix/glossary/changelog entry in one searchable array
data/manifest.json    Inventory of all 1,608 site routes
```

## Data shape

`data/<book>.json`:

```jsonc
{
  "book": "uspsa",
  "source": "https://rules.uspsa.org/uspsa",
  "fetchedAt": "2026-06-17T…",
  "chapterCount": 12, "sectionCount": 72, "ruleCount": 538, "appendixCount": 21,
  "chapters": [
    { "number": "5", "title": "Competitor Equipment",
      "sections": [
        { "number": "5.6", "title": "Chronograph and Power Factors", "chapter": "5",
          "rules": [ { "number": "5.6.1", "title": null, "text": "One or more official match chronographs…" } ] }
      ] }
  ],
  "appendices": [ { "number": "C2", "title": "Chronograph", "text": "Match Chronograph and Equipment Set-Up…" } ],
  "glossary":   [ { "term": "Freestyle", "definition": "…an expression used interchangeably with…" } ],
  "changelog":  [ { "ref": "1.1.5.2", "date": "1/26/2026", "changes": ["Old: …", "New: …"] } ]
}
```

`data/rules-flat.json` — one record per rule/appendix:

```jsonc
{ "book": "uspsa", "type": "rule", "chapter": "5", "chapterTitle": "Competitor Equipment",
  "section": "5.6", "sectionTitle": "Chronograph and Power Factors",
  "number": "5.6.1", "title": null, "text": "One or more official match chronographs…" }
```

## Usage

Refresh the cache from the live site (requires the site's data backend to be up):

```bash
node scripts/extract.mjs
```

Search the cache:

```bash
node scripts/search.mjs "chronograph power factor"
node scripts/search.mjs --book scsa "start signal"
node scripts/search.mjs --book uspsa --limit 5 disqualification
node scripts/search.mjs 10.5.1            # look up an exact rule number
```

## Coverage & limitations

- **1,337 numbered rules**, **56 appendices**, **40 glossary terms**, and
  **5 changelog entries** across the three books — all with full text.
- **Appendix tables/diagrams** (target dimensions, division equipment, etc.) are
  captured as readable text; tabular layout and images are not preserved.
- The per-rule pages (`/<book>/rule/<n>`) are listed in `manifest.json` but not
  separately stored — they duplicate the content already captured from sections.
- Numbering and wording **mirror the source** at `fetchedAt`. The USPSA rulebook
  is "evergreen" (updated in place), so re-run `extract.mjs` to refresh.
