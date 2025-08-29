// shodanBrowser.js
require('dotenv').config();
const fs = require('fs');
const puppeteer = require('puppeteer');

const LOGIN_URL = 'https://account.shodan.io/login';
const ADV_URL   = 'https://www.shodan.io/search/advanced';

const USER         = process.env.SHODAN_USER;
const PASS         = process.env.SHODAN_PASS;
const USER_DATA_DIR = process.env.USER_DATA_DIR || '/home/pptruser/.puppeteer-profile';

if (!USER || !PASS) {
  console.error('❌ Set SHODAN_USER and SHODAN_PASS in your environment or .env');
  process.exit(1);
}

function resolveExecutable() {
  const candidates = [
    process.env.BROWSER_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH, // definido por la imagen oficial
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  if (process.env.BROWSER_PATH) {
    console.warn('[warn] BROWSER_PATH no existe; se usará el binario por defecto de Puppeteer.');
  }
  return null; // que Puppeteer elija
}

const EXECUTABLE = resolveExecutable();

class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(task) {
    const next = this.p.then(() => task().catch(e => { throw e; }));
    this.p = next.catch(() => {});
    return next;
  }
}

class ShodanBrowser {
  constructor() {
    this.browser = null;
    this.page = null;
    this.mutex = new Mutex();
  }

  async launch() {
    if (this.browser) return;
    const launchOpts = {
      headless: true,
      userDataDir: USER_DATA_DIR,
      defaultViewport: { width: 1366, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    };
    if (EXECUTABLE) launchOpts.executablePath = EXECUTABLE;
    this.browser = await puppeteer.launch(launchOpts);
    this.page = await this.browser.newPage();
    await this._ensureLoggedIn();
  }

  async _ensureLoggedIn() {
    await this.page.goto(LOGIN_URL, { waitUntil: ['domcontentloaded', 'networkidle2'] });

    if (/account\.shodan\.io\/login/.test(this.page.url())) {
      await this.page.waitForSelector('form[action="/login"]', { timeout: 60000 });
      await this.page.type('input[name="username"]', USER, { delay: 40 });
      await this.page.type('input[name="password"]', PASS, { delay: 40 });
      await this.page.keyboard.press('Enter');

      await this.page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] });

      if (/account\.shodan\.io\/login/.test(this.page.url())) {
        console.log('[!] CAPTCHA/2FA detectado. Completa una vez en este perfil; esperando…');
        await this.page.waitForFunction(
          () => location.hostname.endsWith('shodan.io') && !/account\.shodan\.io\/login/.test(location.href),
          { timeout: 0 }
        );
      }
    }
  }

  async search(query, opts = {}) {
    const pagesToFetch = Math.max(1, Number(opts.pages ?? 2)); // por defecto 2 (pág. 1 y 2)

    return this.mutex.run(async () => {
      if (!this.browser || !this.page) await this.launch();
      await this._ensureLoggedIn();

      // Ir a búsqueda avanzada y lanzar la consulta (página 1)
      await this.page.goto(ADV_URL, { waitUntil: ['domcontentloaded', 'networkidle2'] });
      await this.page.waitForSelector('#search-query', { timeout: 60000 });
      await this.page.$eval('#search-query', el => { el.value = ''; });
      await this.page.type('#search-query', query, { delay: 20 });

      await Promise.all([
        this.page.click('button.button-red[type="submit"]'),
        this.page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] })
      ]);

      const scrapeCurrent = async () => {
        await this.page.waitForSelector('div.result, .search-result, .banner', { timeout: 60000 });
        return this.page.evaluate(() => {
          const $ = (sel, root = document) => root.querySelector(sel);
          const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
          const getText = el => (el ? el.textContent.trim() : null);
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
      };

      // Página 1
      const byPage = [];
      byPage.push(await scrapeCurrent());

      // Páginas siguientes (2..N) usando /search?query=...&page=k
      if (pagesToFetch > 1) {
        const url = new URL(this.page.url());
        for (let p = 2; p <= pagesToFetch; p++) {
          url.searchParams.set('page', String(p));
          await this.page.goto(url.toString(), { waitUntil: ['domcontentloaded', 'networkidle2'] });
          byPage.push(await scrapeCurrent());
        }
      }

      const results = byPage.flat();
      return { query, pages: pagesToFetch, counts: byPage.map(a => a.length), count: results.length, results };
    });
  }

  async close() {
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
  }
}

module.exports = new ShodanBrowser();
