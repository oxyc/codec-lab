// Holds one response back for the lab's slow-delivery cases: /slow/init-6/… delays init.mp4 by six seconds,
// /slow/seg1-10/… delays segment 1 by ten, and everything else under the prefix is served unchanged. It tells the page
// whenever it holds one back, so a player that never fetched through it is reported as unmeasured rather than passing.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^(.*?)\/slow\/(init|seg(\d+))-(\d+)\/(.*)$/);
  if (!match) return;
  const [, base, what, segment, seconds, rest] = match;
  const target = `${url.origin}${base}/${rest}${url.search}`;
  const name = rest.split('/').pop();
  const held = what === 'init' ? name === 'init.mp4' : name === `seg${segment}.m4s`;
  event.respondWith((async () => {
    if (held) {
      // Media requests often carry no client id, so every open page hears it.
      for (const client of await self.clients.matchAll()) client.postMessage({ lab: 'held', name, seconds: Number(seconds) });
      await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000));
    }
    const response = await fetch(target, { headers: event.request.headers });
    // A fresh Response, not the fetched one: that carries the real file's URL, and hls.js resolves a playlist's
    // relative URIs against it, which would take every later request out from under /slow/.
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  })());
});
