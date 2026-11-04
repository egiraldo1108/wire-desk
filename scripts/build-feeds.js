#!/usr/bin/env node
/** Wire Desk's scheduled RSS builder. Publishes headlines, short publisher
 * descriptions and story images to the same origin as the static app. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.cwd();
const OUT = path.join(ROOT, 'feeds.json');

function readFeeds() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = html.split('<script>').pop().split('</script>')[0];
  const GN = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const GTOP = (hl, gl) => `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
  const GSITE = (site, hl, gl) => `https://news.google.com/rss/search?q=${encodeURIComponent('site:' + site + ' when:2d')}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
  const feeds = script.match(/const FEEDS = (\[[\s\S]*?\n\]);/);
  const catalog = script.match(/const CATALOG = (\[[\s\S]*?\n\]);/);
  if (!feeds) throw new Error('Could not find FEEDS in index.html');
  const context = { GN, GTOP, GSITE };
  const run = match => match ? vm.runInNewContext('(' + match[1] + ')', context, { timeout: 1000 }) : [];
  return [...new Set([
    ...run(feeds).filter(f => f.kind === 'rss').map(f => f.url),
    ...run(catalog).filter(f => f.k === 'rss').map(f => f.u)
  ].filter(Boolean))];
}

function decode(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(x[\da-f]+|\d+);/gi, (all, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&quot;/gi, '"').replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
function plain(value) {
  return decode(decode(value)).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function short(value, title) {
  const text = plain(value);
  if (!text || text.toLowerCase() === plain(title).toLowerCase()) return '';
  if (text.length <= 300) return text;
  return text.slice(0, 297).replace(/\s+\S*$/, '').trim() + '…';
}
function rawTag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(block);
  return m ? m[1] : '';
}
function tag(block, name) { return plain(rawTag(block, name)); }
function attrs(block) {
  const out = {};
  for (const m of block.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decode(m[2] === undefined ? m[3] : m[2]);
  }
  return out;
}
function safeURL(value, base) {
  if (!value) return '';
  try {
    const u = new URL(decode(value).trim(), base);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.href;
  } catch { return ''; }
}
function linkOf(block, base) {
  for (const m of block.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.href && (!a.rel || a.rel === 'alternate')) return safeURL(a.href, base);
  }
  return safeURL(tag(block, 'link') || tag(block, 'guid'), base);
}
function imageOf(block, base) {
  const images = [];
  for (const m of block.matchAll(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (!a.url || /^(audio|video)\//i.test(a.type || '') || /^(audio|video)$/i.test(a.medium || '')) continue;
    if (/^<enclosure/i.test(m[0]) && !/^image\//i.test(a.type || '') && !/\.(png|jpe?g|webp)(\?|$)/i.test(a.url)) continue;
    images.push({ url: safeURL(a.url, base), width: +a.width || 0 });
  }
  const rich = decode(rawTag(block, 'content:encoded') || rawTag(block, 'description') || rawTag(block, 'content') || rawTag(block, 'summary'));
  for (const m of rich.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (+a.width === 1 || +a.height === 1) continue;
    images.push({ url: safeURL(a['data-src'] || a.src, base), width: +a.width || 0 });
  }
  return images.filter(i => i.url).sort((a, b) => b.width - a.width)[0]?.url || '';
}
function parse(xml, feedURL) {
  const out = [], google = /(^|\/)news\.google\.com\//i.test(feedURL || '');
  for (const m of xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi)) {
    const block = m[1], t = tag(block, 'title');
    const l = linkOf(block, feedURL);
    if (!t || !l) continue;
    const summary = google ? '' : rawTag(block, 'description') || rawTag(block, 'summary') || rawTag(block, 'content:encoded') || rawTag(block, 'content');
    out.push({ t, l, d: tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'),
      s: short(summary, t), i: imageOf(block, l), p: google ? tag(block, 'source') : '' });
    if (out.length >= 40) break;
  }
  return out;
}

async function fetchText(url, accept, timeout = 15000, maxBytes = 2_000_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WireDesk/2.0; +https://github.com/egiraldo1108/wire-desk)',
      Accept: accept
    }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); size += value.length;
    }
    await reader.cancel();
    return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), url: res.url };
  } finally { clearTimeout(timer); }
}
async function grab(url) {
  try {
    const res = await fetchText(url, 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*');
    const items = parse(res.text, url);
    if (!items.length) throw new Error('No feed items');
    return { ok: true, items };
  } catch (e) { return { ok: false, err: e.message }; }
}
async function pool(values, size, worker) {
  const results = {}; let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, values.length) }, async () => {
    while (i < values.length) { const value = values[i++]; results[value] = await worker(value); }
  }));
  return results;
}
function metadata(html, base) {
  const tags = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.content) tags[(a.property || a.name || '').toLowerCase()] = a.content;
  }
  return { s: short(tags['og:description'] || tags['twitter:description'] || tags.description),
    i: safeURL(tags['og:image'] || tags['twitter:image'], base) };
}

async function main() {
  const urls = readFeeds();
  console.log(`Fetching ${urls.length} feeds with story summaries and images`);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(OUT, 'utf8')).items || {}; } catch {}
  const cached = new Map(Object.values(previous).flat().map(item => [item.l, item]));
  const got = await pool(urls, 8, grab);
  const items = {}; let ok = 0;
  for (const url of urls) {
    const result = got[url];
    if (result.ok) { items[url] = result.items; ok++; }
    else if (previous[url]) items[url] = previous[url];
    if (!result.ok) console.log(`  Kept previous data: ${url} (${result.err})`);
    for (const item of items[url] || []) {
      const old = cached.get(item.l);
      if (old) { item.s ||= old.s || ''; item.i ||= old.i || ''; }
    }
  }

  // Bound metadata work; Google's redirect-page branding is not a story image.
  const targets = new Map();
  for (const [url, stories] of Object.entries(items)) {
    if (new URL(url).hostname === 'news.google.com') continue;
    for (const item of stories.slice(0, 5)) {
      if ((!item.i || !item.s) && safeURL(item.l) && new URL(item.l).hostname !== 'news.google.com') {
        if (!targets.has(item.l)) targets.set(item.l, []);
        targets.get(item.l).push(item);
      }
      if (targets.size >= 100) break;
    }
    if (targets.size >= 100) break;
  }
  console.log(`Checking publisher previews for ${targets.size} stories`);
  await pool([...targets.keys()], 6, async url => {
    try {
      const res = await fetchText(url, 'text/html', 6000, 400_000);
      const meta = metadata(res.text, res.url);
      for (const item of targets.get(url)) { item.s ||= short(meta.s, item.t); item.i ||= meta.i; }
    } catch { /* Optional metadata never blocks publishing the headlines. */ }
  });

  const key = title => plain(title).toLowerCase().replace(/\s+-\s+[^-]{2,40}$/, '').replace(/[^a-z0-9]/g, '');
  const media = new Map();
  for (const item of Object.values(items).flat()) if (item.i && item.s) media.set(key(item.t), item);
  for (const item of Object.values(items).flat()) {
    const match = media.get(key(item.t));
    if (match) { item.s ||= match.s; item.i ||= match.i; }
  }
  const stories = Object.values(items).flat();
  if (!stories.length) throw new Error('No feeds available; refusing to overwrite feeds.json');
  fs.writeFileSync(OUT, JSON.stringify({ built: Date.now(), items }));
  console.log(`Fetched ${ok}/${urls.length} feeds; saved ${stories.length} stories, ${stories.filter(i => i.i).length} photos, ${stories.filter(i => i.s).length} synopses`);
}

module.exports = { parse, imageOf, metadata, safeURL, plain, readFeeds, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
