(function () {
  'use strict';

  /* ============================ SETTINGS ============================ */
  const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i;

  // The description block on TPB. We ONLY scan inside these — never the whole page.
  const DESCRIPTION_SELECTORS = ['#descr', '#description_text'];

  // Never treat these as screenshots.
  const SKIP_HOSTS = [
    'thepiratebay.org', 'imdb.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com',
    'google.com', 'wikipedia.org', 'facebook.com', 't.me', 'telegram.me',
    'cloudflare.com', 'jsdelivr.net', 'cloudfront.net', 'apibay.org', 'torrindex.net',
  ];

  // A link is considered a screenshot candidate only if it is a direct image
  // OR its host/path looks like an image host/viewer. Plain links are ignored.
  const HOST_HINT = /(img|image|pic|screens?|thumb|traffic|upload|photo|gallery|host|fap|porn|xxx|pixs?|imgs?|curl)/i;
  const VIEWER_HINT = /(\/image\/|\/img[-/]|\/i\/|\/v\/|\/p\/|\/view|\/show|\/photo|\/gallery|viewer\.php|\.html?$)/i;

  const THUMB_HINT = /(thumb|_t\.|\/th\/|\/tn\/|\/small\/|[-_.]small|preview|[-_.]s\.)/i;

  const MAX_CONCURRENT = 4;
  const THUMB_MAX_H = 280;        // preview height, px
  const CLICK_MODE = 'newtab';    // 'newtab' | 'lightbox'
  const MAX_LINKS = 60;           // hard cap, prevents runaway galleries
  /* ================================================================= */

  const SELF_HOST = location.hostname.replace(/^www\./, '');
  const processed = new Set();    // URLs we've already handled (global dedupe)
  let injectedCount = 0;

  // returns 'direct' | 'viewer' | 'skip'
  function classify(raw) {
    let u; try { u = new URL(raw); } catch { return 'skip'; }
    if (!/^https?:$/.test(u.protocol)) return 'skip';
    const host = u.hostname.replace(/^www\./, '');
    if (host === SELF_HOST) return 'skip';
    if (SKIP_HOSTS.some(h => host === h || host.endsWith('.' + h))) return 'skip';
    if (IMG_EXT.test(u.pathname)) return 'direct';
    // Only treat as a viewer if it actually looks like an image host/viewer.
    if (HOST_HINT.test(host) || VIEWER_HINT.test(u.pathname + u.search)) return 'viewer';
    return 'skip'; // plain info link → ignore, no warning
  }

  function bg(msg) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false })); }
      catch { resolve({ ok: false }); }
    });
  }

  let active = 0; const q = [];
  function schedule(fn) { return new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); }); }
  function pump() {
    while (active < MAX_CONCURRENT && q.length) {
      const { fn, res, rej } = q.shift(); active++;
      fn().then(res, rej).finally(() => { active--; pump(); });
    }
  }

  // Try to guess a direct image URL for JS-only viewers (e.g. imagecurl).
  function guessDirect(pageUrl) {
    try {
      const u = new URL(pageUrl);
      const host = u.hostname.replace(/^www\./, '');
      const file = u.searchParams.get('file');
      if (host.includes('imagecurl') && file) {
        // imagecurl serves the raw file from its files path / cdn
        return [
          `${u.protocol}//${u.hostname}/files/${file}`,
          `https://cdn.imagecurl.com/files/${file}`,
          `http://cdn.imagecurl.com/files/${file}`,
        ];
      }
    } catch {}
    return [];
  }

  // page URL -> array of direct image URLs
  async function resolveToImages(url) {
    if (IMG_EXT.test(new URL(url).pathname)) return [url];

    const r = await schedule(() => bg({ type: 'fetchText', url }));
    if (!r.ok) return null;
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const abs = v => { try { return new URL(v, url).href; } catch { return null; } };
    let out = [];

    out = [...doc.querySelectorAll('a[href]')]
      .map(a => a.getAttribute('href')).filter(h => h && IMG_EXT.test(h))
      .map(abs).filter(Boolean).filter(x => !THUMB_HINT.test(x));

    if (!out.length) {
      out = [...doc.querySelectorAll('img')]
        .map(i => i.getAttribute('src') || i.getAttribute('data-src') || i.getAttribute('data-original') || i.getAttribute('data-full'))
        .filter(s => s && IMG_EXT.test(s)).map(abs).filter(Boolean).filter(x => !THUMB_HINT.test(x));
    }
    if (!out.length) {
      doc.querySelectorAll('meta[property="og:image"],meta[property="og:image:url"],meta[name="og:image"],meta[name="twitter:image"],meta[name="twitter:image:src"],link[rel="image_src"]')
        .forEach(m => { const v = abs(m.getAttribute('content') || m.getAttribute('href')); if (v) out.push(v); });
    }
    if (!out.length) out = guessDirect(url); // JS-only viewers
    return [...new Set(out)];
  }

  // page URL -> { status, images:[{full,data}] }
  const cache = new Map();
  function getImages(pageUrl) {
    if (cache.has(pageUrl)) return cache.get(pageUrl);
    const p = (async () => {
      const direct = await resolveToImages(pageUrl);
      if (direct === null) return { status: 'fetchfail', images: [] };
      if (!direct.length) return { status: 'empty', images: [] };
      const images = [];
      for (const d of direct) {
        const r = await schedule(() => bg({ type: 'fetchImage', url: d }));
        if (r.ok) images.push({ full: d, data: r.dataUrl });
      }
      if (!images.length) return { status: 'imgfail', images: [] };
      return { status: 'ok', images };
    })();
    cache.set(pageUrl, p);
    return p;
  }

  function makeError(text, href) {
    const f = document.createElement('a');
    f.className = 'ise-failed';
    f.href = href; f.target = '_blank'; f.rel = 'noopener';
    f.textContent = '⚠ ' + text; f.title = href;
    return f;
  }

  async function handleOne(url, gallery) {
    const ph = document.createElement('div');
    ph.className = 'ise-thumb ise-loading';
    gallery.appendChild(ph);

    let result;
    try { result = await getImages(url); }
    catch { result = { status: 'fetchfail', images: [] }; }
    ph.remove();

    if (result.status === 'ok') {
      for (const it of result.images) {
        const img = document.createElement('img');
        img.className = 'ise-img'; img.src = it.data; img.loading = 'lazy';
        img.title = 'Click to open full size';
        img.addEventListener('click', () => {
          if (CLICK_MODE === 'lightbox') lightbox(it.data);
          else window.open(it.full, '_blank', 'noopener');
        });
        gallery.appendChild(img);
      }
      return;
    }
    // One concise warning per failed screenshot.
    let msg;
    if (result.status === 'fetchfail') msg = 'Screenshot host is down or unreachable';
    else if (result.status === 'imgfail') msg = 'Screenshot unavailable — image removed';
    else msg = 'Screenshot could not be loaded';
    gallery.appendChild(makeError(msg, url));
  }

  function lightbox(src) {
    const o = document.createElement('div'); o.className = 'ise-lb';
    const i = document.createElement('img'); i.src = src; o.appendChild(i);
    o.addEventListener('click', () => o.remove());
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { o.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(o);
  }

  const URL_RE = /https?:\/\/[^\s<>"'\]\[)]+/g;

  // Collect every candidate URL inside the description block, de-duplicated.
  function collectUrls(root) {
    const found = [];
    const seen = new Set();
    const add = raw => {
      const url = raw.replace(/[.,;:]+$/, '');
      if (seen.has(url)) return;
      const c = classify(url);
      if (c === 'skip') return;
      seen.add(url); found.push(url);
    };
    root.querySelectorAll('a[href]').forEach(a => add(a.href));
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf('http') < 0) return NodeFilter.FILTER_REJECT;
        const p = n.parentNode; if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('.ise-gallery')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n; while ((n = tw.nextNode())) {
      const m = n.nodeValue.match(URL_RE);
      if (m) m.forEach(add);
    }
    return found;
  }

  let ran = false;
  function scan() {
    // Find the description block; if it's not there yet, do nothing (observer will retry).
    let block = null;
    for (const sel of DESCRIPTION_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) { block = el; break; }
    }
    if (!block) return;

    const urls = collectUrls(block).filter(u => !processed.has(u));
    if (!urls.length) return;

    // Build ONE gallery right after the description block.
    let gallery = block.parentNode.querySelector(':scope > .ise-gallery');
    if (!gallery) {
      gallery = document.createElement('div');
      gallery.className = 'ise-gallery';
      block.parentNode.insertBefore(gallery, block.nextSibling);
    }

    for (const url of urls) {
      if (injectedCount >= MAX_LINKS) break;
      processed.add(url);
      injectedCount++;
      handleOne(url, gallery);
    }
    ran = true;
  }

  // Observe until the description is built, then stop observing to avoid loops.
  let t;
  const obs = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      scan();
      if (ran) obs.disconnect(); // description handled once — no infinite re-scan
    }, 400);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  scan();
  // Safety: stop observing after 15s no matter what.
  setTimeout(() => obs.disconnect(), 15000);
})();
