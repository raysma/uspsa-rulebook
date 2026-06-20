#!/usr/bin/env node
// Extract the full USPSA / Multigun / Steel Challenge rulebooks from
// rules.uspsa.org by reading the React Server Component (RSC) flight payloads.
//
// Data sources (no headless browser required):
//   GET /<book>                      (RSC) -> table of contents:
//                                      { chapters:[...], sectionsByChapter:{...} }
//   GET /<book>/section/<number>     (RSC) -> clean rule data objects:
//                                      {"number","title","text"} (+ nested markup)
//
// Output: data/<book>.json (hierarchical) and data/rules-flat.json (flat index).

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BOOKS = ["uspsa", "multigun", "scsa"];
const BASE = "https://rules.uspsa.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CONCURRENCY = 5;
const DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRSC(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { "User-Agent": UA, RSC: "1", "Accept-Language": "en-US,en;q=0.9" },
      });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(2 ** i * 1000);
    }
  }
}

// Capture a balanced {...} or [...] block starting at the value after `key`.
function extractBalanced(text, key) {
  const at = text.indexOf(key);
  if (at === -1) return null;
  let i = at + key.length;
  while (i < text.length && text[i] !== "{" && text[i] !== "[") i++;
  const open = text[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }
  return null;
}

// --- Primary: clean rule data objects {"number":..,"title":..,"text":..} ---
// (The markup/element form starts ["$","div","5.6.1",{...}] and is skipped.)
const RULE_RE =
  /\{"number":"([0-9.]+)","title":(null|"(?:\\.|[^"\\])*"),"text":(null|"(?:\\.|[^"\\])*")/g;

function extractFlatRules(rsc) {
  const rules = [];
  const seen = new Set();
  for (const m of rsc.matchAll(RULE_RE)) {
    const number = m[1];
    if (seen.has(number)) continue; // de-dupe if a number appears twice
    seen.add(number);
    let text = JSON.parse(m[3]);
    // A text of "$1c" etc. is a flight reference (lazy-streamed content, used
    // for recently-changed rules) — null it so the prose fallback fills it.
    if (typeof text === "string" && /^\$/.test(text)) text = null;
    rules.push({ number, title: JSON.parse(m[2]), text });
  }
  return rules;
}

// --- Fallback: rules whose body is rendered only as `rule-prose` markup ---
// (section-level prose, appendices, multi-paragraph rules with text:null).

// Readable text from an RSC slice, faithful to the rendered page. Inline runs
// (text, links, <mark>/<s> diff spans, glossary triggers) are concatenated with
// NO inserted separator so the source strings' own spacing is preserved (this
// keeps cross-reference numbers like "1.1.5" that carry no letters, and avoids
// artifacts like "shooting position ," from space-joining). A space is injected
// only at block-level boundaries (<p>, <li>, <div>, …). React keys and flight
// references ("$L1b") are dropped.
function proseText(slice) {
  const cleaned = slice
    .replace(/(\["\$","(?:p|div|li|br|tr|ul|ol|h[1-6]|table|tbody|thead)")/g, '" ",$1')
    .replace(/"className":"(?:\\.|[^"\\])*"/g, "")
    .replace(/"(?:href|data-slot|id|style|term)":"(?:\\.|[^"\\])*"/g, "")
    .replace(/\["\$","[^"]*",(?:"(?:\\.|[^"\\])*"|null),/g, "")
    .replace(/"[a-zA-Z_][a-zA-Z0-9_-]*":/g, "");
  let out = "";
  for (const m of cleaned.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    let s;
    try { s = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    const isKey = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s) && /[0-9]/.test(s) && !/\s/.test(s);
    if (isKey || s.startsWith("$")) continue;
    out += s;
  }
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1") // no space before closing punctuation
    .replace(/\(\s+/g, "(") // no space after opening paren
    .trim();
}

// Balanced [...] or "..." following the first `"children":` after `from`.
function childrenAfter(text, from) {
  let i = text.indexOf('"children":', from);
  if (i === -1) return "";
  i += '"children":'.length;
  if (text[i] === '"') {
    const m = /^"(?:\\.|[^"\\])*"/.exec(text.slice(i));
    return m ? m[0] : "";
  }
  let depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return "";
}

// Balanced [...] or {...} block starting at index `i`.
function balancedFrom(text, i) {
  const open = text[i], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return "";
}

// Rule-number badges (section header + per-rule) with positions.
function badges(text) {
  const out = [];
  const re = /(?:bg-navy|bg-muted)[^}]{0,120}?"children":"([0-9]+(?:\.[0-9]+)*)"/g;
  for (const m of text.matchAll(re)) out.push({ num: m[1], at: m.index });
  return out;
}

function extractProseRules(rsc) {
  rsc = stripPopovers(rsc); // drop popover definitions (and their nested blocks)
  const bs = badges(rsc);
  const rules = [];
  for (let p = rsc.indexOf("rule-prose"); p !== -1; p = rsc.indexOf("rule-prose", p + 1)) {
    const text = proseText(childrenAfter(rsc, p));
    if (!text) continue;
    let num = null;
    for (const b of bs) if (b.at < p) num = b.num; else break;
    if (num) rules.push({ number: num, text });
  }
  return rules;
}

// Natural sort by dotted-number segments (1.2.10 after 1.2.9).
const cmpNum = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? -1) !== (pb[i] ?? -1)) return (pa[i] ?? -1) - (pb[i] ?? -1);
  }
  return 0;
};

// Appendices render as free-form prose (tables/lists/diagrams) without the
// flat shape or numeric badges — capture the full readable text as one blob.
function extractAppendixText(rsc) {
  rsc = stripPopovers(rsc); // drop popover definitions (and their nested blocks)
  const chunks = [];
  for (let p = rsc.indexOf("rule-prose"); p !== -1; p = rsc.indexOf("rule-prose", p + 1)) {
    const t = proseText(childrenAfter(rsc, p));
    if (t) chunks.push(t);
  }
  return chunks.join("\n");
}

// Glossary: {"term":"X","content":[...prose...]} (deduped by term).
function extractGlossary(rsc) {
  const map = new Map();
  const re = /"term":"((?:\\.|[^"\\])*)","content":/g;
  let m;
  while ((m = re.exec(rsc))) {
    const term = JSON.parse('"' + m[1] + '"');
    let i = re.lastIndex;
    while (i < rsc.length && rsc[i] !== "[" && rsc[i] !== "{") i++;
    const definition = proseText(balancedFrom(rsc, i));
    if (!map.has(term) || definition.length > map.get(term).length) map.set(term, definition);
  }
  return [...map].map(([term, definition]) => ({ term, definition }));
}

// Remove glossary popover definitions ("content":[…] / {…}) wholesale, including
// the definition <p> paragraphs nested inside them, so they don't leak into
// changelog/rule/appendix text. String-valued "content" (e.g. <meta content>)
// is left alone.
function stripPopovers(slice) {
  let out = slice;
  let from = 0;
  for (;;) {
    const i = out.indexOf('"content":', from);
    if (i === -1) break;
    let j = i + '"content":'.length;
    while (j < out.length && /\s/.test(out[j])) j++;
    if (out[j] === "[" || out[j] === "{") {
      const block = balancedFrom(out, j);
      if (!block) { from = j; continue; }
      out = out.slice(0, i) + out.slice(j + block.length);
      from = i; // re-scan from here (handles adjacent popovers)
    } else {
      from = j; // string value — not a popover, skip
    }
  }
  return out;
}

// Changelog: the whole page is a flat list of <p> paragraphs in document order.
// A paragraph containing "Approved by BOD …" is an entry header (rule link +
// date); the paragraphs after it (Old:/New: text) belong to that entry, until
// the next header. Walking every top-level <p> avoids truncating to one block.
function extractChangelog(rsc) {
  // Pre-strip popovers so their nested definition <p>s aren't walked as entries.
  rsc = stripPopovers(rsc);
  const starts = [...rsc.matchAll(/\["\$","p","b\d+",/g)].map((m) => m.index);
  const entries = [];
  let cur = null;
  for (let j = 0; j < starts.length; j++) {
    // Bound each paragraph to its own balanced [...] extent — flight byte-order
    // is not visual order, so slicing to the next match can bleed to EOF.
    const slice = balancedFrom(rsc, starts[j]);
    const text = proseText(slice);
    // An entry header is a paragraph whose first child is a <strong> (the rule
    // ref) followed by " · " and an <em> approval label; Old/New paragraphs
    // start with an <em> instead. Keying on the <strong> catches every entry,
    // including ones whose label isn't "Approved by BOD" (e.g. admin changes).
    // Check this BEFORE skipping empty text, so a header with an unrenderable
    // (lazy-ref) label is never dropped.
    const isHeader = /"children":\[\["\$","strong"/.test(slice);
    if (!isHeader && !text) continue;
    if (isHeader) {
      if (cur) entries.push(cur);
      // ref = the header's first <strong> text: a linked rule number ("3.3",
      // "1.1.5.2") or plain text ("App. C2, #3").
      const strongAt = slice.indexOf('"strong"');
      const ref = strongAt !== -1 ? proseText(childrenAfter(slice, strongAt)) : "";
      cur = {
        ref: ref || null,
        date: (text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/) || [])[0] || null,
        changes: [],
      };
    } else if (cur) {
      cur.changes.push(text);
    }
  }
  if (cur) entries.push(cur);

  // Trailing footnote/page markers ("… USPSA HQ. 4") leak into the diff text.
  const dropFootnote = (s) => (s == null ? s : s.replace(/\s+\d{1,2}\s*$/, "").trim());

  // Normalize each entry's body into old/new where labelled.
  for (const e of entries) {
    const body = e.changes.join(" ").replace(/\s+/g, " ").trim();
    const old = body.match(/Old:\s*(.*?)(?:\s*New:|$)/);
    const neu = body.match(/New:\s*(.*)$/);
    e.old = dropFootnote(old ? old[1].trim() : null);
    e.new = dropFootnote(neu ? neu[1].trim() : null);
    e.text = dropFootnote(body);
  }
  return entries;
}

// Merge flat rules (authoritative) with prose fallback (fills gaps/null text).
function extractRules(rsc) {
  const map = new Map();
  for (const r of extractFlatRules(rsc)) map.set(r.number, r);
  for (const r of extractProseRules(rsc)) {
    const existing = map.get(r.number);
    if (!existing) map.set(r.number, { number: r.number, title: null, text: r.text });
    else if (existing.text == null || existing.text === "") existing.text = r.text;
  }
  return [...map.values()].sort((a, b) => cmpNum(a.number, b.number));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i], i);
        await sleep(DELAY_MS);
      }
    })
  );
  return out;
}

async function extractBook(book) {
  process.stderr.write(`\n[${book}] fetching table of contents…\n`);
  const toc = await fetchRSC(`/${book}`);
  if (!toc) throw new Error(`${book}: TOC not found`);
  const chapters = extractBalanced(toc, '"chapters":') || [];
  const sectionsByChapter = extractBalanced(toc, '"sectionsByChapter":') || {};
  const appendixIndex = extractBalanced(toc, '"appendices":') || [];

  const sections = [];
  for (const ch of chapters) {
    for (const s of sectionsByChapter[ch.number] || []) {
      sections.push({ chapter: ch.number, ...s });
    }
  }
  process.stderr.write(
    `[${book}] ${chapters.length} chapters, ${sections.length} sections\n`
  );

  const fetched = await mapLimit(sections, CONCURRENCY, async (s) => {
    const rsc = await fetchRSC(`/${book}/section/${s.number}`);
    const rules = rsc ? extractRules(rsc) : [];
    process.stderr.write(`[${book}] ${s.number} (${rules.length} rules)\n`);
    return { ...s, rules };
  });

  // Re-assemble into chapter hierarchy.
  const byChapter = new Map(chapters.map((c) => [c.number, { ...c, sections: [] }]));
  for (const s of fetched) byChapter.get(s.chapter)?.sections.push(s);

  // Appendices.
  const appendices = await mapLimit(appendixIndex, CONCURRENCY, async (a) => {
    const rsc = await fetchRSC(`/${book}/appendix/${a.number}`);
    const text = rsc ? extractAppendixText(rsc) : "";
    process.stderr.write(`[${book}] appendix ${a.number} (${text.length} chars)\n`);
    return { ...a, text };
  });

  // Glossary and changelog (one page each per book).
  const glossRsc = await fetchRSC(`/${book}/glossary`);
  const glossary = glossRsc ? extractGlossary(glossRsc) : [];
  const clRsc = await fetchRSC(`/${book}/changelog`);
  const changelog = clRsc ? extractChangelog(clRsc) : [];
  process.stderr.write(
    `[${book}] glossary ${glossary.length} terms, changelog ${changelog.length} entries\n`
  );

  const ruleCount = fetched.reduce((n, s) => n + s.rules.length, 0);
  return {
    book,
    source: BASE + `/${book}`,
    fetchedAt: new Date().toISOString(),
    chapterCount: chapters.length,
    sectionCount: sections.length,
    ruleCount,
    appendixCount: appendices.length,
    glossaryCount: glossary.length,
    changelogCount: changelog.length,
    chapters: [...byChapter.values()],
    appendices,
    glossary,
    changelog,
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const flat = [];
  const routes = [];
  for (const book of BOOKS) {
    const data = await extractBook(book);
    await writeFile(
      join(OUT_DIR, `${book}.json`),
      JSON.stringify(data, null, 2) + "\n"
    );
    for (const ch of data.chapters)
      for (const s of ch.sections)
        for (const r of s.rules)
          flat.push({
            book,
            type: "rule",
            chapter: ch.number,
            chapterTitle: ch.title,
            section: s.number,
            sectionTitle: s.title,
            number: r.number,
            title: r.title,
            text: r.text,
          });
    for (const a of data.appendices)
      flat.push({
        book,
        type: "appendix",
        chapter: "Appendix",
        chapterTitle: "Appendices",
        section: a.number,
        sectionTitle: a.title,
        number: a.number,
        title: a.title,
        text: a.text,
      });
    for (const g of data.glossary)
      flat.push({
        book,
        type: "glossary",
        chapter: "Glossary",
        chapterTitle: "Glossary",
        section: null,
        sectionTitle: null,
        number: null,
        title: g.term,
        text: g.definition,
      });
    for (const c of data.changelog)
      flat.push({
        book,
        type: "changelog",
        chapter: "Changelog",
        chapterTitle: "Change Log",
        section: c.ref,
        sectionTitle: c.date,
        number: c.ref,
        title: c.date ? `Change to ${c.ref} (${c.date})` : `Change to ${c.ref}`,
        text: c.text,
      });

    // Per-book route inventory (the full crawled surface).
    routes.push({ book, kind: "book", path: `/${book}` });
    routes.push({ book, kind: "glossary", path: `/${book}/glossary` });
    routes.push({ book, kind: "changelog", path: `/${book}/changelog` });
    for (const ch of data.chapters)
      for (const s of ch.sections) {
        routes.push({ book, kind: "section", path: `/${book}/section/${s.number}`, number: s.number });
        for (const r of s.rules)
          routes.push({ book, kind: "rule", path: `/${book}/rule/${r.number}`, number: r.number });
      }
    for (const a of data.appendices)
      routes.push({ book, kind: "appendix", path: `/${book}/appendix/${a.number}`, number: a.number });

    process.stderr.write(
      `[${book}] done: ${data.ruleCount} rules, ${data.appendixCount} appendices, ` +
        `${data.glossaryCount} glossary, ${data.changelogCount} changelog -> data/${book}.json\n`
    );
  }
  await writeFile(
    join(OUT_DIR, "rules-flat.json"),
    JSON.stringify(flat, null, 2) + "\n"
  );

  // Full surface manifest: every route the site exposes for these books.
  const manifest = {
    site: BASE,
    fetchedAt: new Date().toISOString(),
    books: BOOKS,
    apiEndpoints: [
      { path: "/api/search?rs=<book>&q=<query>", method: "GET", returns: "JSON search results (snippets)" },
    ],
    notes: [
      "All page routes return their structured content as a React Server Component (RSC) flight payload when requested with the header `RSC: 1`.",
      "Rule pages (/<book>/rule/<n>) duplicate the content extracted from section pages.",
    ],
    routeCount: routes.length + 1,
    routes: [{ kind: "home", path: "/" }, ...routes],
  };
  await writeFile(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  process.stderr.write(
    `\nTotal: ${flat.length} entries -> data/rules-flat.json\n` +
      `Surface: ${manifest.routeCount} routes -> data/manifest.json\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
