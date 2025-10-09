// background service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'collect_gifs') {
    chrome.scripting.executeScript({
      target: { tabId: msg.tabId },
      func: pageCrawler,
      args: [msg.depth]
    }).then((results) => {
      const gifUrls = (results?.[0]?.result) || [];
      if (!gifUrls.length) {
        sendResponse({ message: 'No GIFs found.' });
        return;
      }

      let downloaded = 0;
      for (const u of gifUrls) {
        const url = u;
        // derive a safe filename from the URL and preserve path if requested:
        let pathname = (new URL(url)).pathname; // e.g., /images/foo/bar.gif
        pathname = pathname.replace(/^\//, ''); // remove leading slash
        // sanitize filename pieces to remove problematic chars
        const safePath = pathname.split('/').map(p => p.replace(/[<>:"\\|?*\x00-\x1F]/g, '_')).join('/');
        const filename = msg.preservePath ? `gifs/${safePath}` : `gifs/${url.split('/').pop().split('?')[0]}`;

        chrome.downloads.download({ url, filename }, (dlId) => {
          // ignore errors here; continue
          downloaded++;
          // Optionally: you could collect errors via chrome.runtime.lastError
        });
      }

      sendResponse({ message: `Started ${gifUrls.length} downloads (check your Downloads folder).` });
    }).catch(err => {
      sendResponse({ message: 'Error running crawler: ' + (err && err.message) });
    });

    // keep channel open for sendResponse async
    return true;
  }
});


// This function runs in the page context.
// It finds .gif URLs on the current page and (optionally) follows same-origin
// links up to the requested depth (depth: 0 = current page only, 1 = follow links one level).
async function pageCrawler(depth = 0) {
  const origin = location.origin;
  const visited = new Set();
  const results = new Set();

  // helper: extract gif URLs from a document
  function collectFromDoc(doc, baseURL) {
    // img tags
    for (const img of Array.from(doc.images || [])) {
      try {
        const src = new URL(img.src, baseURL).href;
        if (src.toLowerCase().split('?')[0].endsWith('.gif')) results.add(src);
      } catch(e) { /* ignore */ }
    }
    // anchors that directly link to gif files
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      try {
        const href = new URL(a.getAttribute('href'), baseURL).href;
        if (href.toLowerCase().split('?')[0].endsWith('.gif')) results.add(href);
      } catch(e) {}
    }
    // CSS background-image references (simple heuristic)
    const elems = Array.from(doc.querySelectorAll('*[style]'));
    for (const el of elems) {
      const m = (el.style && el.style.backgroundImage) || '';
      const urlMatch = /url\((['"]?)([^'")]+)\1\)/.exec(m);
      if (urlMatch) {
        try {
          const bg = new URL(urlMatch[2], baseURL).href;
          if (bg.toLowerCase().split('?')[0].endsWith('.gif')) results.add(bg);
        } catch(e){}
      }
    }
  }

  async function visitPage(url, currentDepth) {
    if (visited.has(url)) return;
    visited.add(url);
    try {
      const resp = await fetch(url, { credentials: 'same-origin' });
      const text = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      collectFromDoc(doc, url);

      if (currentDepth < depth) {
        // find same-origin links and queue them
        const anchors = Array.from(doc.querySelectorAll('a[href]'));
        for (const a of anchors) {
          try {
            const href = new URL(a.getAttribute('href'), url);
            if (href.origin === origin) {
              const normalized = href.href.split('#')[0];
              if (!visited.has(normalized)) {
                await visitPage(normalized, currentDepth + 1);
              }
            }
          } catch(e){}
        }
      }
    } catch (e) {
      // network/CORS/etc — ignore and continue
    }
  }

  // start with current document (fast)
  try {
    collectFromDoc(document, location.href);
  } catch (e) {}

  if (depth > 0) {
    // gather same-origin links from the current page and visit them (one level)
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const toVisit = [];
    for (const a of anchors) {
      try {
        const href = new URL(a.getAttribute('href'), location.href);
        if (href.origin === origin) {
          toVisit.push(href.href.split('#')[0]);
        }
      } catch(e){}
    }
    // visit each (sequentially to avoid hammering)
    for (const v of toVisit) {
      if (!visited.has(v)) await visitPage(v, 1);
    }
  }

  return Array.from(results);
}
