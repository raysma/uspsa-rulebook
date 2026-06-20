#!/usr/bin/env node
// Render the cached rulebooks (data/<book>.json) into a Claude-Project-friendly
// Markdown tree under claude-project/<book>/.
//
// Layout per book (optimized for retrieval + exact citation):
//   00-index.md                     overview, edition note, how to cite
//   chapter-NN-<slug>.md            one file per chapter (sections + rules)
//   appendix-<id>-<slug>.md         one file per appendix (divisions included)
//   glossary.md                     one entry per defined term
//   changelog.md                    board-approved changes
//
// Every rule/appendix/term heading carries its exact identifier, so any chunk
// the retriever returns is self-citing.

import { writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, "..", "data");
const OUT_DIR = join(ROOT, "..", "claude-project");
const BOOKS = ["uspsa", "multigun", "scsa"];

const BOOK_NAME = {
  uspsa: "USPSA Competition Rules",
  multigun: "USPSA Multigun Rules",
  scsa: "Steel Challenge (SCSA) Rules",
};

const slug = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[''"".,()/&–—]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

const pad2 = (n) => String(n).padStart(2, "0");

function chapterMd(book, ch, edition) {
  const lines = [];
  lines.push(`# ${BOOK_NAME[book]} — Chapter ${ch.number}: ${ch.title}`);
  lines.push("");
  lines.push(`> ${edition}. Cite rules by the number shown in each heading.`);
  lines.push("");
  for (const s of ch.sections) {
    lines.push(`## ${s.number}  ${s.title || ""}`.trimEnd());
    lines.push("");
    for (const r of s.rules) {
      const head = r.title ? `${r.number} — ${r.title}` : r.number;
      lines.push(`### ${head}`);
      lines.push("");
      lines.push((r.text || "").trim() || "_(No standalone text; see sub-rules.)_");
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

function appendixMd(book, a, edition) {
  return (
    `# ${BOOK_NAME[book]} — Appendix ${a.number}: ${a.title}\n\n` +
    `> ${edition}. Cite as "Appendix ${a.number} — ${a.title}".\n` +
    `> Note: tables and diagrams from the source are captured as text only.\n\n` +
    `${(a.text || "").trim()}\n`
  );
}

function glossaryMd(book, glossary, edition) {
  const lines = [`# ${BOOK_NAME[book]} — Glossary`, "", `> ${edition}. Cite as a glossary entry by term.`, ""];
  for (const g of glossary.sort((x, y) => x.term.localeCompare(y.term))) {
    lines.push(`### ${g.term}`);
    lines.push("");
    lines.push((g.definition || "").trim());
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function changelogMd(book, changelog, edition) {
  const lines = [
    `# ${BOOK_NAME[book]} — Change Log`,
    "",
    `> ${edition}. Board-approved rule changes. Old = removed text, New = added text.`,
    "",
  ];
  for (const c of changelog) {
    lines.push(`### ${c.ref || "Change"}${c.date ? ` — approved ${c.date}` : ""}`);
    lines.push("");
    if (c.old || c.new) {
      if (c.old) lines.push(`- **Old:** ${c.old}`);
      if (c.new) lines.push(`- **New:** ${c.new}`);
    } else if (c.text) {
      lines.push(c.text);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function indexMd(book, data, edition, files) {
  const lines = [
    `# ${BOOK_NAME[book]} — Index`,
    "",
    `**Edition:** ${edition}`,
    `**Source:** ${data.source} (retrieved ${data.fetchedAt.slice(0, 10)})`,
    "",
    `This knowledge base is the ${BOOK_NAME[book]}, split for retrieval. Each rule,`,
    `appendix, and glossary entry is headed by its exact identifier — cite by that`,
    `identifier (e.g. \`10.5.11\`, "Appendix D7 — Carry Optics Division", or a glossary term).`,
    "",
    `**Contents:** ${data.chapterCount} chapters, ${data.ruleCount} rules, ` +
      `${data.appendixCount} appendices, ${data.glossaryCount} glossary terms, ` +
      `${data.changelogCount} change-log entries.`,
    "",
    "## Chapters",
    "",
  ];
  for (const ch of data.chapters) lines.push(`- **Chapter ${ch.number}** — ${ch.title}`);
  lines.push("");
  lines.push("## Appendices");
  lines.push("");
  for (const a of data.appendices) lines.push(`- **Appendix ${a.number}** — ${a.title}`);
  lines.push("");
  lines.push("## Files");
  lines.push("");
  for (const f of files) lines.push(`- \`${f}\``);
  return lines.join("\n").trimEnd() + "\n";
}

async function buildBook(book) {
  const data = JSON.parse(await import("node:fs").then((m) => m.readFileSync(join(DATA_DIR, `${book}.json`), "utf8")));
  const edition = `Per the ${data.fetchedAt.slice(0, 4)} ${BOOK_NAME[book]}`;
  const dir = join(OUT_DIR, book);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const files = [];
  const write = async (name, content) => {
    await writeFile(join(dir, name), content);
    files.push(name);
  };

  for (const ch of data.chapters) {
    await write(`chapter-${pad2(ch.number)}-${slug(ch.title)}.md`, chapterMd(book, ch, edition));
  }
  for (const a of data.appendices) {
    if (!(a.text || "").trim()) continue; // skip stubs (e.g. A3 -> see glossary.md)
    await write(`appendix-${a.number}-${slug(a.title)}.md`, appendixMd(book, a, edition));
  }
  if (data.glossary.length) await write("glossary.md", glossaryMd(book, data.glossary, edition));
  if (data.changelog.length) await write("changelog.md", changelogMd(book, data.changelog, edition));

  // index last, so it can list the files
  await writeFile(join(dir, "00-index.md"), indexMd(book, data, edition, files.sort()));

  process.stderr.write(`[${book}] ${files.length + 1} markdown files -> claude-project/${book}/\n`);
}

await mkdir(OUT_DIR, { recursive: true });
for (const book of BOOKS) await buildBook(book);
process.stderr.write("done\n");
