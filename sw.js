// AM CHAT service worker — كاش (الشبكة أولاً) + إشعارات Push
const C='amchat-v4';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['./','index.html','manifest.json','icon-192.png']).catch(()=>{})))});
self.addEventListener('activate',e=>e.waitUntil((async()=>{const ks=await caches.keys();await Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)));await self.clients.claim()})()));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(u.origin!==location.origin&&!/fonts\.(googleapis|gstatic)\.com/.test(u.host))return;
  const fresh=r.mode==='navigate'||/\.html$|\/$|sw\.js$/.test(u.pathname);
  e.respondWith(fetch(r,fresh?{cache:'no-cache'}:{}).then(res=>{if(res.ok&&!u.search){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match('index.html'))))});

// وصول إشعار — يشتغل حتى لو التطبيق مسدود
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){try{d={data:{body:e.data.text()}}}catch(y){}}
  const p=Object.assign({},d.notification||{},d.data||{});if(!d.data&&!d.notification)Object.assign(p,d);
  e.waitUntil((async()=>{
    if(p.badge&&self.navigator&&self.navigator.setAppBadge){try{await self.navigator.setAppBadge(Math.max(1,+p.badge||1))}catch(x){}}
    await self.registration.showNotification(p.title||'AM CHAT',{body:p.body||'رسالة جديدة',icon:p.icon||'icon-192.png',badge:'icon-192.png',tag:p.tag||p.cid||'amchat',renotify:true,data:{cid:p.cid||''},vibrate:[60,40,60],timestamp:Date.now()});
  })())});
self.addEventListener('notificationclick',e=>{e.notification.close();const cid=e.notification.data&&e.notification.data.cid;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{const c=l.find(x=>'focus' in x);if(c){c.postMessage({open:cid});return c.focus()}return self.clients.openWindow('./'+(cid?'#c='+encodeURIComponent(cid):''))}))});
