import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parsePrice, slugQuery, cleanTitle, looksSame, cheapestPerStore,
  extractJsonArray, extractJsonObject, extractUrl, badTitle
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERPER = process.env.SERPER_API_KEY;
const ANTH = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple per-visitor limit so nobody can drain your API credits.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60 * 60 * 1000, max = 30;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

async function claude(content, max_tokens = 600) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTH, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const j = await r.json();
  return (j.content || []).map(c => c.text || '').join('');
}

async function pageInfo(url) {
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'accept-language': 'en-IN,en;q=0.9' }
    });
    const html = (await r.text()).slice(0, 400000);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1];
    const title = og || html.match(/<title[^>]*>([^<]+)/i)?.[1] || '';
    let brand = '';
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const d = JSON.parse(m[1]);
        const items = Array.isArray(d) ? d : [d, ...(d['@graph'] || [])];
        const p = items.find(x => x && /Product/.test(x['@type'] || ''));
        if (p) { brand = (typeof p.brand === 'string' ? p.brand : p.brand?.name) || ''; break; }
      } catch {}
    }
    return { title: cleanTitle(title.replace(/&amp;/g, '&').replace(/&#39;/g, "'")), brand, finalUrl: r.url };
  } catch { return { title: '', brand: '', finalUrl: url }; }
}

// Fallback when a shop blocks our server: let the price service open the page for us.
async function scrapeTitle(url) {
  try {
    const r = await fetch('https://scrape.serper.dev', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return '';
    const j = await r.json();
    return cleanTitle(j.metadata?.title || j.metadata?.['og:title'] || '');
  } catch { return ''; }
}

async function identify({ url, text, image }) {
  let title = text || '', brand = '';
  if (url) {
    const info = await pageInfo(url);
    let best = badTitle(info.title) ? '' : info.title;
    if (!best) {
      const slug = slugQuery(info.finalUrl || url);
      if (slug.length >= 12) best = slug;
    }
    if (!best) { const t = await scrapeTitle(url); if (!badTitle(t)) best = t; }
    title = best || text || '';
    if (text && best && !best.toLowerCase().includes(text.toLowerCase())) title = best + ' ' + text;
    brand = info.brand;
  }
  if (ANTH && (image || title)) {
    try {
      const content = [];
      if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
      content.push({ type: 'text', text:
`Identify this exact product so it can be found on other Indian shopping sites.
Text from the shopper/page: "${title}" ${brand ? '(brand: ' + brand + ')' : ''}
Reply with JSON only: {"name":"full product title","brand":"","color":"","query":"5-9 word search text, brand first, include colour and key design words"}` });
      const o = extractJsonObject(await claude(content));
      if (o && o.query) return { name: o.name || o.query, brand: o.brand || brand, color: o.color || '', query: o.query };
    } catch (e) { console.error('identify', e.message); }
  }
  if (!title) return null;
  return { name: title, brand, color: '', query: title };
}

async function search(query) {
  const r = await fetch('https://google.serper.dev/shopping', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER, 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'in', hl: 'en', num: 40 })
  });
  if (!r.ok) throw new Error('Price service ' + r.status);
  const j = await r.json();
  return (j.shopping || []).map(x => ({
    store: x.source || 'Unknown', title: x.title || '', price: parsePrice(x.price),
    link: x.link, image: x.imageUrl, rating: x.rating
  })).filter(x => x.price && x.link);
}

async function keepExact(identity, results) {
  if (ANTH && results.length) {
    try {
      const list = results.map((r, i) => `${i}. ${r.title} [${r.store}]`).join('\n');
      const out = await claude(
`The shopper wants EXACTLY this product: "${identity.name}" (brand: ${identity.brand || 'unknown'}, colour: ${identity.color || 'unknown'}).
From the list, return the numbers of listings that are the SAME product: same brand, same design/model and same colour. Ignore size. Exclude similar-looking but different items, other colours, other brands, and accessories.
Reply with a JSON array of numbers only, e.g. [0,3]. Use [] if none.

${list}`, 300);
      const keep = new Set(extractJsonArray(out));
      return results.filter((_, i) => keep.has(i));
    } catch (e) { console.error('match', e.message); }
  }
  return results.filter(r => looksSame(identity, r.title));
}

app.post('/api/compare', async (req, res) => {
  try {
    if (!SERPER) return res.status(500).json({ error: 'The price service is not set up yet (missing SERPER_API_KEY).' });
    if (limited(req.ip)) return res.status(429).json({ error: 'Too many searches. Please try again in a while.' });
    let { url, text, image } = req.body || {};
    if (!url && text) { const x = extractUrl(text); if (x.url) { url = x.url; text = x.rest; } }
    if (!url && !text && !image) return res.status(400).json({ error: 'Send a product link, a name or an image.' });
    if (image && !ANTH) return res.status(400).json({ error: 'Image search needs the Claude key to be set up. Please paste a link or a name.' });

    const identity = await identify({ url, text, image });
    if (!identity) return res.status(422).json({ error: 'Could not work out what the product is. Try pasting the product link.' });

    const results = await search(identity.query);
    const exact = await keepExact(identity, results);
    const offers = cheapestPerStore(exact);
    res.json({ product: identity, offers, checked: results.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong while checking prices. Please try again.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('PriceHunt running on port ' + port));
