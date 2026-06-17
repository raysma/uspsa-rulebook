# uspsa-rulebook

A local, queryable cache of the official USPSA competition rules published at
[rules.uspsa.org](https://rules.uspsa.org) — the USPSA, Multigun, and Steel
Challenge (SCSA) rulebooks, extracted into plain JSON for search and querying.

See [`INVESTIGATION.md`](INVESTIGATION.md) for how the source site is built and
how the extraction works.

## What's here

```
scripts/extract.mjs   Pull all three rulebooks from rules.uspsa.org into data/
scripts/search.mjs    Search the cached rules (no dependencies)
data/uspsa.json       USPSA rules — hierarchical (chapters → sections → rules) + appendices
data/multigun.json    Multigun rules — same shape
data/scsa.json        Steel Challenge rules — same shape
data/rules-flat.json  All rules + appendices flattened into one searchable array
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
  "appendices": [ { "number": "C2", "title": "Chronograph", "text": "Match Chronograph and Equipment Set-Up…" } ]
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

- **1,337 numbered rules** across the three books, plus **56 appendices**, all
  with full text.
- **Glossary (Appendix A3)** is rendered client-side on the source site, so its
  term/definition list is not in the server payload and is not captured here.
  Inline glossary definitions still appear within rule text where referenced.
- **Appendix tables/diagrams** (target dimensions, division equipment, etc.) are
  captured as readable text; tabular layout and images are not preserved.
- Rule/appendix **numbering and wording mirror the source** at `fetchedAt`. The
  USPSA rulebook is "evergreen" (updated in place), so re-run `extract.mjs` to
  refresh.
