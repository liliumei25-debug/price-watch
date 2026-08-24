const CACHE = 'price-watch-v8-gold-futures-fix';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request).then(r=>r||caches.match('./index.html'))));});
self.addEventListener('push',event=>{
  if(!event.data)return; let data={}; try{data=event.data.json();}catch{data={body:event.data.text()};}
  event.waitUntil(self.registration.showNotification(data.title||'Price Watch',{body:data.body||'',icon:data.icon||'./icons/icon-192.png',badge:data.badge||'./icons/icon-192.png',tag:data.tag||'price-watch-background',data:data.data||{}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close(); const target=event.notification.data?.url||self.location.origin;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{for(const client of clients){if(client.url.startsWith(self.location.origin)&&'focus' in client)return client.focus();}return self.clients.openWindow(target);}));
});
