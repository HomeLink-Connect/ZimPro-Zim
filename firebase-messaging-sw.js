/* ZimPro-Linkup service worker — shows call & message notifications when the app is minimised or closed.
   Needs NO Firebase library: the server (netlify/functions/push.js) sends data-only pushes and this file displays them. */
const ICON = 'icons/zpl-192.png';
const scopeUrl = p => new URL(p, self.registration.scope).href;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});            /* pass-through (keeps the app installable on older Chrome) */

function parse(event){
  let p = {};
  try{ p = event.data ? event.data.json() : {}; }catch(e){ try{ p = { data:{ body:event.data.text() } }; }catch(_){} }
  const d = Object.assign({}, p.notification || {}, p.data || (p.type || p.title ? p : {}));
  return d;
}
async function appIsVisible(){
  const list = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
  return list.some(c => c.visibilityState === 'visible' && c.focused !== false);
}

self.addEventListener('push', event => {
  const d = parse(event);
  if(!d || (!d.type && !d.title)) return;
  event.waitUntil((async () => {
    /* app is open on screen → the page already rings / shows the message itself */
    if(await appIsVisible()) return;

    if(d.type === 'call'){
      const age = Date.now() - (+d.ts || Date.now());
      if(age > 60000) return;                                   /* stale call, don't ring */
      const tag = 'call_' + d.callId;
      const opts = {
        body: d.body || (d.video === '1' ? 'Incoming ZimPro video call' : 'Incoming ZimPro voice call'),
        icon: d.photo || ICON, badge: ICON, tag, renotify:true, requireInteraction:true, silent:false,
        vibrate:[500,250,500,250,500,250,500],
        actions:[{ action:'answer', title:'Answer' }, { action:'decline', title:'Decline' }],
        data:{ kind:'call', callId:d.callId, uid:d.uid, name:d.name }
      };
      await self.registration.showNotification((d.name || 'Someone') + ' is calling…', opts);
      /* keep it "ringing": re-alert every 5 s (up to ~35 s) while the notification is still on screen */
      for(let i = 0; i < 7; i++){
        await new Promise(r => setTimeout(r, 5000));
        const still = await self.registration.getNotifications({ tag });
        if(!still.length) break;
        await self.registration.showNotification((d.name || 'Someone') + ' is calling…', opts);
      }
      return;
    }

    await self.registration.showNotification(d.title || d.name || 'New message', {
      body: d.body || 'You have a new message',
      icon: d.photo || ICON, badge: ICON, tag: 'msg_' + (d.convId || d.uid || 'x'), renotify:true,
      vibrate:[200,100,200], data:{ kind:'message', uid:d.uid, name:d.name, convId:d.convId }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  const n = event.notification, data = n.data || {};
  n.close();
  event.waitUntil((async () => {
    const act = event.action === 'decline' ? 'decline' : (event.action === 'answer' ? 'answer' : '');
    if(data.kind === 'call' && act === 'decline'){
      const list = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
      if(list.length){ list.forEach(c => c.postMessage({ type:'zpl-open', kind:'call', callId:data.callId, action:'decline' })); return; }
      /* app is fully closed: open it quietly just to send the "declined" signal */
      return self.clients.openWindow(scopeUrl('./?from=push&open=call&act=decline&callId=' + encodeURIComponent(data.callId || '')));
    }
    const list = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    const msg = Object.assign({ type:'zpl-open', action:act }, data);
    for(const c of list){
      if('focus' in c){ await c.focus(); c.postMessage(msg); return; }
    }
    const q = new URLSearchParams({ from:'push', open:data.kind || '', uid:data.uid || '', name:data.name || '', callId:data.callId || '', act });
    return self.clients.openWindow(scopeUrl('./?' + q.toString()));
  })());
});
