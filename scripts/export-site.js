// Writes the public website pages out as plain .html files in site/, so they
// can be opened straight from the folder without running the app.
//
// The app is started in test mode with an empty, throwaway database, each page
// is fetched, and its links are rewritten to point at the other files. Every
// page is written twice: once at normal size, and once in site/bigger/, which
// is what the "Make the text bigger" link opens.
//
// Run with: npm run export-site

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { MockTelephony } from '../src/telephony.js';
import { createApp } from '../src/server.js';

const quiet = { info() {}, warn() {}, error() {} };
const root = new URL('../', import.meta.url);
const out = fileURLToPath(new URL('site/', root));

// Address on the website, and the file it becomes.
const PAGES = {
  '/': 'index.html',
  '/how-it-works': 'how-it-works.html',
  '/safety': 'safety.html',
  '/questions': 'questions.html',
  '/groups': 'groups.html',
  '/join': 'join.html',
  '/signin': 'signin.html',
  '/forgot': 'forgot.html',
};

// Turns the app's own addresses into links between the files. `up` is '../'
// for pages in site/bigger/, so pictures are shared rather than copied twice.
function relink(html, { path, big, up }) {
  const other = big ? '../' : 'bigger/';
  const missing = new Set();
  html = html
    // The text size link swaps between the normal and bigger copies of this page.
    .replace(/href="\/text-size\?[^"]*"/g, `href="${other}${PAGES[path]}"`)
    // Forms need the running app, so here they just stay on the same page.
    .replace(/ action="\/[^"]*"/g, ' action="#"')
    .replace(/<input type="hidden" name="_csrf" value="[^"]*">/g, '')
    .replace(/(href|src)="\/images\//g, `$1="${up}images/`)
    .replace(/href="(\/[^"#?]*)(#[^"]*)?"/g, (match, target, hash = '') => {
      if (PAGES[target]) return `href="${PAGES[target]}${hash}"`;
      missing.add(target);
      return match;
    });
  return { html, missing };
}

const config = loadConfig({ telephony: 'mock', dbPath: ':memory:', baseUrl: 'http://localhost' });
const { app } = createApp({ config, db: openDb(':memory:'), telephony: new MockTelephony(quiet), log: quiet });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // A visitor who has pressed "Make the text bigger".
  const res = await fetch(`${base}/text-size?big=1`, { redirect: 'manual' });
  const bigCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  await rm(out, { recursive: true, force: true });
  await mkdir(`${out}bigger`, { recursive: true });
  await cp(fileURLToPath(new URL('public/images/', root)), `${out}images`, { recursive: true });

  const missing = new Set();
  for (const [path, file] of Object.entries(PAGES)) {
    for (const big of [false, true]) {
      const page = await fetch(base + path, { redirect: 'manual', headers: big ? { cookie: bigCookie } : {} });
      if (page.status !== 200) throw new Error(`${path} answered ${page.status}`);
      const result = relink(await page.text(), { path, big, up: big ? '../' : '' });
      result.missing.forEach((m) => missing.add(m));
      await writeFile(`${out}${big ? 'bigger/' : ''}${file}`, result.html);
    }
  }
  console.log(`Wrote ${Object.keys(PAGES).length} pages (plus bigger-text copies) to site/`);
  if (missing.size) console.log(`Links left pointing at the live app: ${[...missing].join(', ')}`);
} finally {
  server.close();
}
