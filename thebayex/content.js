(function () {
  'use strict';

  /* ============================ SETTINGS ============================ */
  const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i;

  // Blocks where screenshots usually live. Scanned first; if none found on the
  // page, the whole <body> is scanned as a fallback.
  const DESCRIPTION_SELECTORS = [
    '#description_text', '#descr', '.text-box',
    '.post', '.postbody', '.message', '.bbWrapper', '.content', 'article',
  ];

  // Domains that are NEVER screenshots (forums, trackers, info sites, trackers).
  // The current site's own host is added automatically.
  const SKIP_HOSTS = [
    'thepiratebay.org', 'imdb.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com',
    'google.com', 'wikipedia.org', 'facebook.com', 't.me', 'telegram.me',
    'cloudflare.com', 'jsdelivr.net', 'cloudfront.net',
  ];

  // Hint that a host/path is an image host — used only to decide whether to show
  // an "unavailable" message vs. silently skip. Loading itself is universal.
  const HOST_HINT = /(img|image|pic|screens?|thumb|traffic|upload|photo|gallery|host|fap|porn|xxx|pixs?|imgs?)/i;
  const VIEWER_HINT = /(\/image\/|\/img[-/]|\/i\/|\/v\/|\/p\/|\/view\/|\/show\/|\/photo\/|\/gallery\/|\.html?$)/i;

  const THUMB_HINT = /(thumb|_t\.|\/th\/|\/tn\/|\/small\/|[-_.]small|preview|[-_.]s\.)/i;

  const MAX_CONCURRENT = 4;
  const THUMB_MAX_H = 280;        // preview height, px
  const CLICK_MODE = 'newtab';    // 'newtab' | 'lightbox'
  /* ================================================================= */

  const SELF_HOST = location.hostname.replace(/^www\./, '');

  function classify(raw) {
    // returns: 'direct' | 'page' | 'skip'
    let u; try { u = new URL(raw); } catch { return 'skip'; }
    if (!/^https?:$/.test(u.protocol)) return 'skip';
    const host = u.hostname.replace(/^www\./, '');
    if (host === SELF_HOST) return 'skip';
    if (SKIP_HOSTS.some(h => host === h || host.endsWith('.' + h))) return 'skip';
    if (IMG_EXT.test(u.pathname)) return 'direct';
    // any other external link is treated as a possible viewer page
    return 'page';
  }

  // does this link *look* like an image host? (only affects error messaging)
  function looksLikeImageHost(raw) {
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, '');
      return HOST_HINT.test(host) || VIEWER_HINT.test(u.pathname);
    } catch { return false; }
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

  // page URL -> array of direct image URLs (full size preferred)
  async function resolveToImages(url) {
    if (IMG_EXT.test(new URL(url).pathname)) return [url];
    const r = await schedule(() => bg({ type: 'fetchText', url }));
    if (!r.ok) return null; // null = could not even fetch the page
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const abs = v => { try { return new URL(v, url).href; } catch { return null; } };
    let out = [];

    out = [...doc.querySelectorAll('a[href]')]
      .map(a => a.getAttribute('href')).filter(h => h && IMG_EXT.test(h))
      .map(abs).filter(Boolean).filter(u => !THUMB_HINT.test(u));

    if (!out.length) {
      out = [...doc.querySelectorAll('img')]
        .map(i => i.getAttribute('src') || i.getAttribute('data-src') || i.getAttribute('data-original') || i.getAttribute('data-full'))
        .filter(s => s && IMG_EXT.test(s)).map(abs).filter(Boolean).filter(u => !THUMB_HINT.test(u));
    }
    if (!out.length) {
      doc.querySelectorAll('meta[property="og:image"],meta[property="og:image:url"],meta[name="og:image"],meta[name="twitter:image"],meta[name="twitter:image:src"],link[rel="image_src"]')
        .forEach(m => { const v = abs(m.getAttribute('content') || m.getAttribute('href')); if (v) out.push(v); });
    }
    return [...new Set(out)];
  }

  // page URL -> { status, images:[{full,data}] }
  // status: 'ok' | 'empty' (page had no images) | 'fetchfail' | 'imgfail'
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
    f.textContent = '⚠ ' + text;
    f.title = href;
    return f;
  }

  async function injectFor(urls, refNode) {
    const gallery = document.createElement('div');
    gallery.className = 'ise-gallery';
    refNode.parentNode.insertBefore(gallery, refNode.nextSibling);

    for (const url of urls) {
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
        continue;
      }

      // Not OK. Decide whether to warn or silently skip.
      const imageHost = looksLikeImageHost(url);
      if (result.status === 'empty' && !imageHost) {
        // Probably just an info/text link, not a screenshot — skip quietly.
        continue;
      }
      let msg;
      if (result.status === 'fetchfail') msg = 'Screenshot host is down or unreachable';
      else if (result.status === 'imgfail') msg = 'Screenshot unavailable — image removed';
      else msg = 'No image found on this page';
      gallery.appendChild(makeError(msg, url));
    }

    // if the gallery ended up empty, remove it
    if (!gallery.childNodes.length) gallery.remove();
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

  function processAnchor(a) {
    if (a.__ise) return;
    const c = classify(a.href);
    if (c === 'skip') return;
    a.__ise = true; injectFor([a.href], a);
  }
  function processTextNode(node) {
    if (node.__ise) return;
    const t = node.nodeValue;
    if (!t || t.indexOf('http') < 0) return;
    const m = [...t.matchAll(URL_RE)]
      .map(x => x[0].replace(/[.,;:]+$/, ''))
      .filter(u => classify(u) !== 'skip');
    if (!m.length) return;
    node.__ise = true; injectFor([...new Set(m)], node);
  }

  function scanRoot(root) {
    root.querySelectorAll('a[href]').forEach(processAnchor);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf('http') < 0) return NodeFilter.FILTER_REJECT;
        const p = n.parentNode; if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'A' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('.ise-gallery')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = []; let n; while ((n = tw.nextNode())) nodes.push(n);
    nodes.forEach(processTextNode);
  }

  function scan() {
    // Prefer description blocks; fall back to whole body if none present.
    const blocks = [];
    for (const sel of DESCRIPTION_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => blocks.push(el));
    }
    if (blocks.length) blocks.forEach(scanRoot);
    else scanRoot(document.body);
  }

  let t;
  const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(scan, 400); });
  obs.observe(document.body, { childList: true, subtree: true });
  scan();
})();
