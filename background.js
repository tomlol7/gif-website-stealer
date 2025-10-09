// background service worker (manifest v3)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'collect_gifs') return;
  const { tabId, cfg } = msg;
  if (!tabId) { sendResponse({ message: 'No tab id' }); return; }

  // Inject the crawler into the page context. It will return an array of GIF URLs it discovered.
  chrome.scripting.executeScript({
    target: { tabId },
    func: pageCrawler,
    args: [cfg.depth, cfg.includeSubdomains, cfg.maxPages]
  }).then((results) => {
    // results can include results from multiple frames; merge them
    let urls = [];
    for (const r of results) {
      if (r && r.result && Array.isArray(r.result)) urls = urls.concat(r.result);
    }
    urls = Array.from(new Set(urls)); // dedupe
    if (!urls.length) {
      sendResponse({ message: 'No GIFs found.', found: 0, started: 0, errors: [] });
      return;
    }

    const errors = [];
    let started = 0;

    // helper: make safe filename
    function makeFilename(urlStr, preservePath) {
      try {
        const u = new URL(urlStr);
        let pathname = decodeURIComponent(u.pathname || '').replace(/^\/+/, '');
        if (!pathname) pathname = u.hostname + '_file';
        // remove query-related junk
        pathname = pathname.split('?')[0];
        // sanitize path segments
        const parts = pathname.split('/').map(p => p.replace(/[<>:"\\|?*\x00-\x1F]/g, '_'));
        const safe = parts.join('/');
        return preservePath ? `gifs/${safe}` : `gifs/${parts[parts.length - 1] || 'file.gif'}`;
      } catch (e) {
        // fallback
        const name = urlStr.split('/').pop().split('?')[0] || 'file.gif';
        return `gifs/${name.replace(/[<>:"\\|?*\x00-\x1F]/g, '_')}`;
      }
    }

    // start downloads (fire-and-forget). Chrome may throttle many simultaneous downloads;
    // we attempt to start them sequentially with a small gap to be polite.
    const gapMs = 120; // small gap between downloads
    urls.forEach((u, i) => {
      const filename = makeFilename(u, cfg.preservePath);
      setTimeout(() => {
        chrome.downloads.download({ url: u, filename }, (dlId) => {
          if (chrome.runtime.lastError) {
            errors.push({ url: u, error: chrome.runtime.lastError.message });
          } else {
            started++;
          }
          // Note: we don't wait for all downloads to finish here; we report started / errors seen at scheduling time.
        });
      }, i * gapMs);
    });

    // respond immediately with summary (downloads have been scheduled)
    sendResponse({ message: 'Downloads scheduled — check your Downloads folder.', found: urls.length, started, errors });
  }).catch((err) => {
    sendResponse({ message: 'Injection failed: ' + (err && err.message), found: 0, started: 0, errors: [] });
  });

  // keep channel open for async sendResponse
  return true;
});

/*
 This function is injected into the page and runs in page context.
 It finds .gif URLs on the current DOM and (optionally) fetches and parses linked pages
 up to the given depth. It returns an array of absolute GIF URLs.
 Note: cross-origin fetches are subject to CORS and may fail — that's normal.
*/
async function pageCrawler(depth = 0, includeSubdomains = false, maxPages = 200) {
  const origin = location.origin;
  const startHost = location.hostname;
  const hostParts = startHost.split('.');
  const baseDomain = hostParts.slice(-2).join('.'); // simple heuristic: example.xyz or example.com

  const visited = new Set();
  const results = new Set();
  let pagesVisited = 0;

  // collect GIF links from a Document object
  function collectFromDoc(doc, baseURL) {
    try {
      // img[src]
      for (const img of Array.from(doc.images || [])) {
        try {
          const src = new URL(img.src, baseURL).href;
          if (src.toLowerCase().split('?')[0].endsWith('.gif')) results.add(src);
        } catch (e) {}
      }
      // anchor hrefs
      for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
        try {
          const href = new URL(a.getAttribute('href'), baseURL).href;
          if (href.toLowerCase().split('?')[0].endsWith('.gif')) results.add(href);
        } catch (e) {}
      }
      // inline styles background-image
      for (const el of Array.from(doc.querySelectorAll('*[style]'))) {
        try {
          const m = (el.style && el.style.backgroundImage) || '';
          const urlMatch = /url\\((['"]?)([^'")]+)\\1\\)/.exec(m);
          if (urlMatch) {
            const bg = new URL(urlMatch[2], baseURL).href;
            if (bg.toLowerCase().split('?')[0].endsWith('.gif')) results.add(bg);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  function isInScope(urlObj) {
    try {
      if (urlObj.origin === origin) return true;
      if (includeSubdomains) {
        if (urlObj.hostname === baseDomain) return true;
        if (urlObj.hostname.endsWith('.' + baseDomain)) return true;
      }
    } catch (e) { return false; }
    return false;
  }

  // simple BFS queue: {url, depthLevel}
  const queue = [];

  // collect from current DOM first (this is immediate, not CORS-blocked)
  try { collectFromDoc(document, location.href); } catch (e) {}

  // seed queue with links on the current page (if we need to go deeper)
  if (depth > 0) {
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      try {
        const hrefObj = new URL(a.getAttribute('href'), location.href);
        if (isInScope(hrefObj)) {
          const normalized = hrefObj.href.split('#')[0];
          queue.push({ url: normalized, d: 1 });
        }
      } catch (e) {}
    }
  }

  async function visit(url, currentDepth) {
    if (visited.has(url)) return;
    if (pagesVisited >= maxPages) return;
    visited.add(url);
    pagesVisited++;

    try {
      // Attempt to fetch the page. This may fail for cross-origin pages (CORS).
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) return;
      const text = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      collectFromDoc(doc, url);

      if (currentDepth < depth) {
        for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
          try {
            const hrefObj = new URL(a.getAttribute('href'), url);
            if (isInScope(hrefObj)) {
              const normalized = hrefObj.href.split('#')[0];
              if (!visited.has(normalized) && pagesVisited < maxPages) {
                queue.push({ url: normalized, d: currentDepth + 1 });
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      // fetch/CORS errors are expected sometimes: ignore and continue
    }
  }

  // process queue sequentially (safer re: site load)
  while (queue.length && pagesVisited < maxPages) {
    const item = queue.shift();
    await visit(item.url, item.d);
  }

  return Array.from(results);
}
