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
    rules.push({ number, title: JSON.parse(m[2]), text: JSON.parse(m[3]) });
  }
  return rules;
}

// --- Fallback: rules whose body is rendered only as `rule-prose` markup ---
// (section-level prose, appendices, multi-paragraph rules with text:null).

// Readable text from an RSC slice: strip attributes, element headers and
// object keys, then JSON-parse remaining quoted strings; drop React keys.
function proseText(slice) {
  const cleaned = slice
    .replace(/"className":"(?:\\.|[^"\\])*"/g, "")
    .replace(/"(?:href|data-slot|id|style|term)":"(?:\\.|[^"\\])*"/g, "")
    .replace(/\["\$","[^"]*",(?:"(?:\\.|[^"\\])*"|null),/g, "")
    .replace(/"[a-zA-Z_][a-zA-Z0-9_-]*":/g, "");
  const parts = [];
  for (const m of cleaned.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    let s;
    try { s = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    const t = s.trim();
    const isKey = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(t) && /[0-9]/.test(t) && !/\s/.test(t);
    if (/[A-Za-z]/.test(t) && t.length > 1 && !isKey) parts.push(t);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
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

// Changelog: one rule-prose block; each <p> is a fragment. Group fragments into
// entries keyed by the rule-anchor link (href "…#<ref>") that heads each change.
function extractChangelog(rsc) {
  const at = rsc.indexOf('"rule-prose');
  if (at === -1) return [];
  const block = childrenAfter(rsc, at);
  const starts = [...block.matchAll(/\["\$","p","b\d+",/g)].map((m) => m.index);
  const entries = [];
  let cur = null;
  for (let j = 0; j < starts.length; j++) {
    const slice = block.slice(starts[j], starts[j + 1] ?? block.length);
    const text = proseText(slice);
    if (!text) continue;
    const anchor = (slice.match(/"href":"([^"]*#[^"]+)"/) || [])[1];
    if (anchor) {
      if (cur) entries.push(cur);
      cur = {
        ref: anchor.split("#")[1],
        date: (text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/) || [])[0] || null,
        changes: [],
      };
    } else if (cur) {
      cur.changes.push(text);
    }
  }
  if (cur) entries.push(cur);
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
        text: c.changes.join("\n"),
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
