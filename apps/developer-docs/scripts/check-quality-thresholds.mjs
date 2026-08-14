#!/usr/bin/env node
/**
 * Accessibility and search-quality thresholds for the docs portal (#145).
 *
 * These are static, browser-free thresholds derived from the authored MDX and
 * the app's own routing/search configuration, so they run in the same fast
 * gate as the other content checks:
 *
 * Accessibility
 * - every page has a non-empty title and description (page name + meta
 *   description are the primary screen-reader/search affordances);
 * - heading structure starts at level 2 and never skips a level (a jump from
 *   `##` to `####` breaks heading navigation);
 * - every image has non-empty alt text;
 * - every link has discernible text (no bare URLs as link text, no empty
 *   labels), and no link text is a bare "here"/"this"/"link";
 * - no heading is duplicated within a page (duplicate landmarks are
 *   ambiguous to screen-reader navigation).
 *
 * Search quality
 * - every page is reachable from a `meta.json` (an unlisted page is not
 *   navigable and is easy to leave unindexed);
 * - titles are unique across a version, so result lists are disambiguated;
 * - descriptions meet a minimum length so snippets are informative;
 * - the search route and sitemap exist and cover every version.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(appRoot, "content/docs");

const MINIMUM_DESCRIPTION_LENGTH = 40;
const VAGUE_LINK_TEXT = new Set(["here", "this", "link", "click here", "read more"]);

const problems = [];
const stats = { pages: 0, headings: 0, links: 0, images: 0 };

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".mdx")) files.push(full);
  }
  return files.sort();
}

function frontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/u);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/u);
    if (!pair) continue;
    fields[pair[1]] = pair[2].replace(/^["']|["']$/gu, "").trim();
  }
  return fields;
}

function stripFences(contents) {
  return contents.replace(/```[\s\S]*?```/gu, "");
}

const titlesByVersion = new Map();
const listedPages = new Set();

for (const metaFile of (await walk(docsRoot).then(() => collectMeta(docsRoot)))) {
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  const directory = path.dirname(metaFile);
  for (const entry of meta.pages ?? []) {
    const name = entry.replace(/^\.\.\.$/u, "");
    if (!name) continue;
    listedPages.add(path.join(directory, `${name.replace(/^\(.*\)$/u, "")}.mdx`));
    listedPages.add(path.join(directory, name, "index.mdx"));
    listedPages.add(path.join(directory, name));
  }
}

async function collectMeta(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMeta(full)));
    else if (entry.name === "meta.json") files.push(full);
  }
  return files;
}

for (const file of await walk(docsRoot)) {
  const relative = path.relative(appRoot, file).split(path.sep).join("/");
  const contents = await readFile(file, "utf8");
  const fields = frontmatter(contents);
  stats.pages += 1;

  if (!fields) {
    problems.push(`${relative}: missing frontmatter`);
    continue;
  }
  if (!fields.title) problems.push(`${relative}: missing title`);
  if (!fields.description) {
    problems.push(`${relative}: missing description (search snippet + page summary)`);
  } else if (fields.description.length < MINIMUM_DESCRIPTION_LENGTH) {
    problems.push(
      `${relative}: description is ${fields.description.length} characters; the search-quality threshold is ${MINIMUM_DESCRIPTION_LENGTH}`
    );
  }

  const version = relative.split("/")[3] ?? "unknown";
  const titles = titlesByVersion.get(version) ?? new Map();
  if (fields.title) {
    if (titles.has(fields.title)) {
      problems.push(
        `${relative}: duplicate page title "${fields.title}" (also ${titles.get(fields.title)}); search results cannot be disambiguated`
      );
    }
    titles.set(fields.title, relative);
  }
  titlesByVersion.set(version, titles);

  const body = stripFences(contents.slice(contents.indexOf("---", 3) + 3));

  // Heading structure.
  let previousLevel = 1;
  const seenHeadings = new Set();
  for (const match of body.matchAll(/^(#{1,6})\s+(.+)$/gmu)) {
    const level = match[1].length;
    const text = match[2].trim();
    stats.headings += 1;
    if (level === 1) {
      problems.push(`${relative}: level-1 heading "${text}" duplicates the page title`);
    }
    if (level > previousLevel + 1) {
      problems.push(
        `${relative}: heading "${text}" jumps from level ${previousLevel} to ${level}`
      );
    }
    if (seenHeadings.has(text.toLowerCase())) {
      problems.push(`${relative}: duplicate heading "${text}"`);
    }
    seenHeadings.add(text.toLowerCase());
    previousLevel = level;
  }

  // Images need alt text.
  for (const match of body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/gu)) {
    stats.images += 1;
    if (match[1].trim().length === 0) {
      problems.push(`${relative}: image ${match[2]} has empty alt text`);
    }
  }

  // Links need discernible, specific text.
  for (const match of body.matchAll(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/gu)) {
    stats.links += 1;
    const text = match[1].trim();
    if (text.length === 0) {
      problems.push(`${relative}: link to ${match[2]} has no text`);
      continue;
    }
    if (VAGUE_LINK_TEXT.has(text.toLowerCase())) {
      problems.push(`${relative}: link text "${text}" is not discernible out of context`);
    }
    if (/^https?:\/\//u.test(text)) {
      problems.push(`${relative}: link text is a bare URL (${text})`);
    }
  }

  const isIndex = path.basename(file) === "index.mdx";
  if (!isIndex && !listedPages.has(file)) {
    problems.push(`${relative}: not listed in any meta.json, so it is unnavigable and easy to leave unindexed`);
  }
}

// Search + SEO surfaces must exist for every version.
for (const surface of ["app/api/search/route.ts", "app/sitemap.ts", "app/robots.ts"]) {
  if (!existsSync(path.join(appRoot, surface))) {
    problems.push(`missing search/SEO surface ${surface}`);
  }
}
const searchRoute = await readFile(path.join(appRoot, "app/api/search/route.ts"), "utf8");
if (!/version/u.test(searchRoute)) {
  problems.push("the search route does not scope results by version");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`docs-quality: ${problem}`);
  console.error(`\n${problems.length} accessibility/search-quality threshold failures`);
  process.exit(1);
}

console.log(
  `docs quality thresholds passed: ${stats.pages} pages, ${stats.headings} headings, ` +
    `${stats.links} links, ${stats.images} images.`
);
