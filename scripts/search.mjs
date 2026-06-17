#!/usr/bin/env node
// Search the cached USPSA rulebooks (data/rules-flat.json).
//
// Usage:
//   node scripts/search.mjs "chronograph power factor"
//   node scripts/search.mjs --book scsa "start signal"
//   node scripts/search.mjs --book uspsa --limit 5 disqualification
//
// Ranking: term-frequency over title/section/text with boosts for matches in
// the rule number, title, and section title. No dependencies.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "rules-flat.json");

const args = process.argv.slice(2);
let book = null, limit = 10;
const terms = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--book") book = args[++i];
  else if (args[i] === "--limit") limit = Number(args[++i]);
  else terms.push(args[i]);
}
const query = terms.join(" ").toLowerCase().trim();
if (!query) {
  console.error('Usage: node scripts/search.mjs [--book uspsa|multigun|scsa] [--limit N] "query"');
  process.exit(1);
}

const words = query.split(/\s+/).filter(Boolean);
const rules = JSON.parse(readFileSync(DATA, "utf8")).filter((r) => !book || r.book === book);

function score(r) {
  const num = (r.number || "").toLowerCase();
  const title = (r.title || "").toLowerCase();
  const sect = (r.sectionTitle || "").toLowerCase();
  const text = (r.text || "").toLowerCase();
  let s = 0;
  for (const w of words) {
    if (num === w || num === query) s += 50;            // exact rule-number hit
    if (title.includes(w)) s += 8;
    if (sect.includes(w)) s += 4;
    let idx = -1, n = 0;
    while ((idx = text.indexOf(w, idx + 1)) !== -1) n++; // term frequency in body
    s += Math.min(n, 6);
  }
  // small bonus when all query words appear somewhere in the entry
  const hay = `${num} ${title} ${sect} ${text}`;
  if (words.every((w) => hay.includes(w))) s += 5;
  return s;
}

const results = rules
  .map((r) => ({ r, s: score(r) }))
  .filter((x) => x.s > 0)
  .sort((a, b) => b.s - a.s)
  .slice(0, limit);

if (!results.length) {
  console.log(`No matches for "${query}".`);
  process.exit(0);
}

for (const { r, s } of results) {
  const tag =
    r.type === "appendix"
      ? `${r.book.toUpperCase()} Appendix ${r.number}`
      : `${r.book.toUpperCase()} ${r.number}`;
  const head = [tag, r.title, `(${r.sectionTitle})`].filter(Boolean).join(" — ");
  const body = (r.text || "").replace(/\s+/g, " ").trim();
  console.log(`\n[${s}] ${head}`);
  console.log("   " + (body.length > 240 ? body.slice(0, 240) + "…" : body));
}
console.log(`\n${results.length} result(s) for "${query}"${book ? ` in ${book}` : ""}.`);
