#!/usr/bin/env node
/**
 * Wire Desk — feed builder.
 *
 * Runs on GitHub's servers, where there is no such thing as CORS. It fetches
 * every RSS feed listed in index.html and writes the results to feeds.json,
 * which the page then reads from its own domain. Same origin, so no browser
 * permission check, no middleman proxy, nothing to rate-limit you.
 *
 * No dependencies — Node 20's built-in fetch and a small XML reader.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const HTML = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'feeds.json');
const LIVE = path.join(ROOT, 'live.json');

/* ---------- pull the feed list straight out of the page ----------
   One source of truth: add a feed to index.html and the builder picks
   it up on the next run without being edited. */
function readFeeds() {
  const src = fs.readFileSync(HTML, 'utf8');
  const script = src.split('<script>').pop().split('</script>')[0];

  const GN = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const GTOP = (hl, gl) => `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
  const GSITE = (site, hl, gl) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent('site:' + site + ' when:2d')}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;

  const feedsSrc = script.match(/const FEEDS = (\[[\s\S]*?\n\]);/);
  const catalogSrc = script.match(/const CATALOG = (\[[\s\S]*?\n\]);/);
  if (!feedsSrc) throw new Error('could not find FEEDS in index.html');

  const feeds = eval(feedsSrc[1]);
  const catalog = catalogSrc ? eval(catalogSrc[1]) : [];

  const urls = new Set();
  feeds.forEach(f => { if (f.kind === 'rss' && f.url) urls.add(f.url); });
  catalog.forEach(e => { if (e.k === 'rss' && e.u) urls.add(e.u); });
  return [...urls];
}

/* ---------- a small, forgiving XML reader ---------- */
const strip = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? strip(m[1]) : '';
}

function linkOf(block) {
  const href = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  if (href) return href[1].trim();
  const plain = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block);
  if (plain) return strip(plain[1]);
  return tag(block, 'guid');
}

function parse(xml) {
  const out = [];
  const blocks = xml.split(/<(?:item|entry)[\s>]/i).slice(1);
  for (const raw of blocks) {
    const block = '<item ' + raw.split(/<\/(?:item|entry)>/i)[0];
    const t = tag(block, 'title');
    if (!t) continue;
    out.push({
      t,
      l: linkOf(block),
      d: tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || ''
    });
    if (out.length >= 40) break;
  }
  return out;
}

/* ---------- fetch with a timeout, a few at a time ---------- */
async function grab(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wire-desk/1.0; +https://github.com)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.text();
    const items = parse(body);
    if (!items.length) throw new Error('no items');
    return { ok: true, items };
  } catch (e) {
    return { ok: false, err: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function pool(urls, size, worker) {
  const results = {};
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < urls.length) {
      const url = urls[i++];
      results[url] = await worker(url);
    }
  }));
  return results;
}

/* ---------- live channel resolution ----------
   The same trick as the feeds: YouTube blocks the browser, not a server.
   Every channel in the catalog gets resolved here — handle to channel ID,
   channel ID to whatever video is streaming right now — and written to
   live.json. The page then reads it from its own domain, so the manual
   copy-the-link-back step disappears. */
async function page(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    + '(KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    return r.ok ? await r.text() : '';
  } catch (e) {
    return '';
  } finally { clearTimeout(timer); }
}

async function channelId(handleOrId) {
  if (/^UC[\w-]{20,}$/.test(handleOrId)) return handleOrId;
  const html = await page('https://www.youtube.com/' + handleOrId);
  const m = /"(?:channelId|externalId)":"(UC[\w-]{20,})"/.exec(html);
  return m ? m[1] : '';
}

async function liveVideo(id) {
  const html = await page('https://www.youtube.com/channel/' + id + '/live');
  if (html) {
    const isLive = /"isLiveNow"\s*:\s*true|hlsManifestUrl|"liveBroadcastDetails"/.test(html);
    let m = /"videoId":"([\w-]{11})"/.exec(html);
    if (m) return { id: m[1], live: isLive };
  }
  /* Not streaming, or the page was withheld — fall back to the channel's
     RSS feed, whose newest entry is the most recent upload or stream. */
  const xml = await page('https://www.youtube.com/feeds/videos.xml?channel_id=' + id);
  const m = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(xml);
  return m ? { id: m[1], live: false } : null;
}

async function buildLive() {
  const src = fs.readFileSync(HTML, 'utf8');
  const script = src.split('<script>').pop().split('</script>')[0];
  const GN = () => '', GTOP = () => '', GSITE = () => '';
  const catalogSrc = script.match(/const CATALOG = (\[[\s\S]*?\n\]);/);
  if (!catalogSrc) return;
  const channels = eval(catalogSrc[1]).filter(e => e.k === 'yt');

  const out = {};
  let live = 0;
  for (let i = 0; i < channels.length; i += 3) {
    await Promise.all(channels.slice(i, i + 3).map(async (e) => {
      const key = e.v || e.h;                      // how the page refers to it
      const raw = e.v ? e.v.slice(2) : e.h;
      try {
        const cid = await channelId(raw);
        if (!cid) { console.log(`  ${e.n}: no channel id`); return; }
        const vid = await liveVideo(cid);
        if (!vid) { console.log(`  ${e.n}: nothing found`); return; }
        out[key] = { chan: 'c:' + cid, video: vid.id, live: vid.live, name: e.n };
        if (vid.live) live++;
        console.log(`  ${e.n}: ${vid.live ? 'LIVE' : 'idle'} ${vid.id}`);
      } catch (err) {
        console.log(`  ${e.n}: ${err.message}`);
      }
    }));
  }

  /* Keep the previous answer for anything that failed this run. */
  if (fs.existsSync(LIVE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
      for (const k of Object.keys(prev.channels || {})) if (!out[k]) out[k] = prev.channels[k];
    } catch (e) { /* unreadable; carry on */ }
  }

  fs.writeFileSync(LIVE, JSON.stringify({ built: Date.now(), channels: out }));
  console.log(`live: ${live} streaming now, ${Object.keys(out).length} channels resolved`);
}

(async () => {
  const urls = readFeeds();
  console.log(`fetching ${urls.length} feeds`);

  const got = await pool(urls, 8, grab);

  const items = {};
  let ok = 0, failed = [];
  for (const [url, r] of Object.entries(got)) {
    if (r.ok) { items[url] = r.items; ok++; }
    else failed.push(`${url} -> ${r.err}`);
  }

  /* Keep whatever worked last time for anything that failed this run, so a
     single flaky fetch doesn't blank out a source on the page. */
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      for (const url of Object.keys(prev.items || {})) {
        if (!items[url]) items[url] = prev.items[url];
      }
    } catch (e) { /* previous file unreadable; carry on */ }
  }

  fs.writeFileSync(OUT, JSON.stringify({ built: Date.now(), items }));
  console.log(`ok ${ok}/${urls.length}, wrote ${Object.keys(items).length} feeds`);
  if (failed.length) console.log('failed:\n  ' + failed.join('\n  '));

  console.log('resolving live channels');
  await buildLive();
})();
