// Pure helper functions (no network) so they can be tested.

export function parsePrice(p) {
  if (p == null) return null;
  if (typeof p === 'number') return p;
  const m = String(p).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

export function slugQuery(raw) {
  let u;
  try { u = new URL(raw); } catch { return ''; }
  const segs = u.pathname.split('/').filter(Boolean);
  let slug = '';
  const iDp = segs.findIndex(s => s === 'dp' || s === 'p' || s === 'product');
  if (iDp > 0) slug = segs[iDp - 1];
  else if (/myntra\./.test(u.hostname)) {
    const iNum = segs.findIndex(s => /^\d{5,}$/.test(s));
    slug = iNum > 0 ? segs[iNum - 1] : segs[segs.length - 1] || '';
  }
  if (!slug) slug = [...segs].sort((a, b) => b.length - a.length)[0] || '';
  return decodeURIComponent(slug).replace(/\.html?$/, '').replace(/[-_+]+/g, ' ')
    .replace(/\b(buy|online|dp|p)\b/gi, '').replace(/\s+/g, ' ').trim();
}

export function cleanTitle(t) {
  return (t || '')
    .replace(/\s*[|–—-]\s*(Buy|Shop|Myntra|Ajio|Amazon|Flipkart|Nykaa|Tata CLiQ|Meesho).*$/i, '')
    .replace(/^(Buy|Shop)\s+/i, '')
    .replace(/\s+(online|at best price).*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['for','with','and','the','women','womens','woman','men','mens','set','of','in','a','an','by','online','buy','new','latest','pack','combo','ethnic','wear']);
export function tokens(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9ऀ-෿ ]+/g, ' ')
    .split(/\s+/).filter(w => w && !STOP.has(w));
}

// Offline fallback for "same product": brand must match and most key words must appear.
export function looksSame(identity, title) {
  const want = tokens(`${identity.name || ''} ${identity.query || ''}`);
  const have = new Set(tokens(title));
  if (!want.length) return false;
  if (identity.brand) {
    const b = tokens(identity.brand);
    if (b.length && !b.every(w => have.has(w))) return false;
  }
  const uniq = [...new Set(want)];
  const hit = uniq.filter(w => have.has(w)).length;
  return hit / uniq.length >= 0.75;
}

export function cheapestPerStore(offers) {
  const by = new Map();
  for (const o of offers) {
    const k = o.store.toLowerCase();
    if (!by.has(k) || o.price < by.get(k).price) by.set(k, o);
  }
  return [...by.values()].sort((a, b) => a.price - b.price);
}

export function extractJsonArray(text) {
  const m = (text || '').match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch { return []; }
}
export function extractJsonObject(text) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Pull a link out of text like "Product name https://amzn.in/d/abc" (Share buttons paste both).
export function extractUrl(text) {
  const m = (text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return { url: '', rest: (text || '').trim() };
  const url = m[0].replace(/[).,;]+$/, '');
  const rest = (text || '').replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  return { url, rest };
}

export function badTitle(t) {
  return !t || t.length < 6 ||
    /robot|captcha|sorry|access denied|just a moment|attention required|page not found|^amazon(\.in)?$|^flipkart(\.com)?$|online shopping/i.test(t);
}
