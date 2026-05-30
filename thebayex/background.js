// Фоновый service worker: благодаря host_permissions:<all_urls> может качать
// с любого домена без CORS и без запросов к пользователю.

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'fetchText') {
        const r = await fetch(msg.url, { referrerPolicy: 'no-referrer', credentials: 'omit' });
        if (!r.ok) return sendResponse({ ok: false });
        sendResponse({ ok: true, text: await r.text() });
      } else if (msg.type === 'fetchImage') {
        // без Referer — обходит большинство хотлинк-защит
        const r = await fetch(msg.url, { referrerPolicy: 'no-referrer', credentials: 'omit' });
        if (!r.ok) return sendResponse({ ok: false });
        const blob = await r.blob();
        const buf = await blob.arrayBuffer();
        const type = blob.type || 'image/jpeg';
        sendResponse({ ok: true, dataUrl: `data:${type};base64,` + abToBase64(buf) });
      } else {
        sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // ответ асинхронный
});
