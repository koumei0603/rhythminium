const CACHE='v1783700000000';
const SHELL=["./index.html","./style.css","./js/platform.js","./js/audio.js","./js/game.js","./js/ui.js","./songs-index.json","./manifest.json","./assets/mascot.png"];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(res=>{
    if(res.ok&&e.request.method==='GET'){const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));}
    return res;
  })));
});