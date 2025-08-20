#!/usr/bin/env node
/**
 * Express + Puppeteer API for Shodan Advanced Search
 *
 * - Logs in once at startup (reuses a persistent userDataDir).
 * - Keeps the browser open between requests.
 * - POST /search { "query": "product:nginx hostname:google.com" }
 *   -> returns parsed results (title, url, timestamp, hostnames, tags, banner).
 *
 * Env:
 *   SHODAN_USER, SHODAN_PASS (required)
 *   BROWSER_PATH (optional, e.g. /usr/bin/brave-browser)
 *   PORT (optional, default 3000)
 */

require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');

const LOGIN_URL = 'https://account.shodan.io/login';
const ADV_URL   = 'https://www.shodan.io/search/advanced';

const EXECUTABLE = process.env.BROWSER_PATH || null;
const USER       = process.env.SHODAN_USER;
const PASS       = process.env.SHODAN_PASS;
const PORT       = Number(process.env.PORT || 3000);

if (!USER || !PASS) {
  console.error('❌ Set SHODAN_USER and SHODAN_PASS in your environment or .env');
  process.exit(1);
}

// --- Simple async mutex to serialize page use (Shodan blocks rapid parallel navs) ---
class Mutex {
  constructor() { this.p = Promise.resolve(); }
  async run(fn) {
    const next = this.p.then(() => fn().catch(e => { throw e; }));
    this.p = next.catch(() => {}); // keep chain alive
    return next;
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

let browser, page;
const pageMutex = new Mutex();

// --- Helpers ---
async function ensureLoggedIn() {
  // If page is already on shodan and logged in, just return
  try {
    const url = page.url();
    if (/shodan\.io/.test(url) && !/account\.shodan\.io\/login/.test(url)) return;
  } catch (_) {}

  console.log('[*] Opening login page…');
  await page.goto(LOGIN_URL, { waitUntil: ['domcontentloaded', 'networkidle2'] });

  if (/account\.shodan\.io\/login/.test(page.url())) {
    console.log('[*] Filling login form…');
    await page.waitForSelector('form[action="/login"]', { timeout: 60000 });
    await page.type('input[name="username"]', USER, { delay: 40 });
    await page.type('input[name="password"]', PASS, { delay: 40 });

    console.log('[*] Submitting login by pressing Enter…');
    await page.focus('input[name="password"]');
    await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] });

    // If still on login, a CAPTCHA/2FA likely appeared. Wait (no timeout) for manual completion.
    if (/account\.shodan\.io\/login/.test(page.url())) {
      console.log('[!] Still on login (CAPTCHA/2FA?). Complete it manually in the browser profile.');
      await page.waitForFunction(
        () => location.hostname.endsWith('shodan.io') && !/account\.shodan\.io\/login/.test(location.href),
        { timeout: 0 }
      );
    }
  }

  console.log('[*] Login successful.');
}

async function runSearch(query) {
  return pageMutex.run(async () => {
    await ensureLoggedIn();

    console.log('[*] Navigating to advanced search…');
    await page.goto(ADV_URL, { waitUntil: ['domcontentloaded', 'networkidle2'] });
    await page.waitForSelector('#search-query', { timeout: 60000 });

    // Clear, type, submit
    await page.$eval('#search-query', el => { el.value = ''; });
    await page.type('#search-query', query, { delay: 20 });

    await Promise.all([
      page.click('button.button-red[type="submit"]'),
      page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] })
    ]);

    console.log('[*] Waiting for results…');
    // Shodan sometimes renders different card structures; be flexible:
    await page.waitForSelector('div.result, .search-result, .banner', { timeout: 60000 });

    const results = await page.evaluate(() => {
      const $ = (sel, root = document) => root.querySelector(sel);
      const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
      const getText = el => (el ? el.textContent.trim() : null);

      // Prefer modern ".result" cards; fallback to other common containers.
      const cards = $$('.result').length ? $$('.result') : $$('.search-result, .banner');

      return cards.map(card => {
        const titleA = $('.heading a.title, .heading a.title.text-dark, a.title', card) || $('a', card);
        const timestamp = $('.timestamp, time', card);
        const hostnames = $$('.result-hostnames li, li.hostnames, .hostnames li', card).map(li => li.textContent.trim());
        const tags = $$('.result-details a.tag, a.tag, .tags a', card).map(a => a.textContent.trim());
        const bannerPre = $('.banner-data pre, pre.banner, pre', card);

        return {
          title: getText(titleA),
          title_url: titleA ? titleA.href : null,
          timestamp: getText(timestamp),
          hostnames: hostnames.length ? hostnames : null,
          tags: tags.length ? tags : null,
          banner: bannerPre ? bannerPre.textContent.trim() : null
        };
      }).filter(r => r.title || r.banner);
    });

    return { query, count: results.length, results };
  });
}

// --- Routes ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, loggedIn: !!page, ts: new Date().toISOString() });
});

app.post('/search', async (req, res) => {
  try {
    const query = (req.body?.query || req.query?.q || '').toString().trim();
    if (!query) return res.status(400).json({ error: 'Missing "query" in JSON body or ?q=' });

    const out = await runSearch(query);
    res.json(out);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed', detail: String(err && err.message || err) });
  }
});

// --- Startup: launch browser and log in once, keep open ---
(async () => {
  console.log('[*] Launching browser…');
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: './.puppeteer-profile', // persist login/session
    defaultViewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {})
  });

  page = await browser.newPage();

  try {
    await ensureLoggedIn();
  } catch (e) {
    console.error('⚠️ Login step encountered an issue:', e.message);
    // Continue serving; /search will retry ensureLoggedIn() under mutex.
  }

  app.listen(PORT, () => {
    console.log(`🚀 API listening on http://localhost:${PORT}`);
    console.log('   POST /search {"query":"product:nginx hostname:google.com"}');
  });

  // Keep process alive; graceful shutdown:
  const shutdown = async (signal) => {
    console.log(`\n${signal} received, closing browser…`);
    try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
    try { if (browser) await browser.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();