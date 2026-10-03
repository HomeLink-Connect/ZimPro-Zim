/* ZimPro-Linkup push server — Cloudflare Worker (free). GitHub Pages can't run server code, so this tiny
   service sends the phone notification for new messages & calls. index.html calls it after every send.
   Secret needed:  FIREBASE_SERVICE_ACCOUNT  (the service-account JSON text, or base64 of it). */

const API_KEY = 'AIzaSyA7okyR40IeNWJjH5h0cbQF8yYR_5QHi3w';   /* same public web apiKey as in index.html */
const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (code, obj) => new Response(JSON.stringify(obj || {}), { status:code, headers:Object.assign({ 'Content-Type':'application/json' }, CORS) });
const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* ---------- Google service-account auth (RS256 JWT -> access token), cached ---------- */
let SA = null, tokenCache = { value:'', exp:0 };
function loadSA(env){
  if(SA) return SA;
  let raw = env.FIREBASE_SERVICE_ACCOUNT || '';
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not set');
  if(raw.trim().charAt(0) !== '{') raw = atob(raw.trim());
  SA = JSON.parse(raw); return SA;
}
const b64u = buf => { let s = ''; const b = new Uint8Array(buf); for(let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };
const b64uStr = str => b64u(new TextEncoder().encode(str));
async function accessToken(env){
  const now = Math.floor(Date.now() / 1000);
  if(tokenCache.value && tokenCache.exp - 60 > now) return tokenCache.value;
  const sa = loadSA(env);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const head = b64uStr(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim = b64uStr(JSON.stringify({ iss:sa.client_email, scope:'https://www.googleapis.com/auth/cloud-platform', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claim));
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body:'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + b64u(sig) });
  const j = await r.json();
  if(!j.access_token) throw new Error('google auth failed: ' + JSON.stringify(j));
  tokenCache = { value:j.access_token, exp:now + (j.expires_in || 3600) };
  return tokenCache.value;
}

/* ---------- Firestore REST helpers ---------- */
const sv = f => (f && f.stringValue) || '';
async function getDoc(env, path){
  const sa = loadSA(env), at = await accessToken(env);
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents/' + path, { headers:{ Authorization:'Bearer ' + at } });
  if(r.status === 404) return null;
  if(!r.ok) throw new Error('firestore ' + r.status);
  return (await r.json()).fields || {};
}
async function dropTokens(env, uid, tokens){
  const sa = loadSA(env), at = await accessToken(env);
  await fetch('https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents:commit', {
    method:'POST', headers:{ Authorization:'Bearer ' + at, 'Content-Type':'application/json' },
    body:JSON.stringify({ writes:[{ transform:{ document:'projects/' + sa.project_id + '/databases/(default)/documents/users/' + uid,
      fieldTransforms:[{ fieldPath:'fcmTokens', removeAllFromArray:{ values:tokens.map(t => ({ stringValue:t })) } }] } }] })
  }).catch(() => {});
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS') return new Response(null, { status:204, headers:CORS });
    if(request.method !== 'POST') return json(405, { error:'POST only' });
    try{
      const idToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if(!idToken) return json(401, { error:'no token' });
      const lk = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ idToken }) });
      const lj = await lk.json();
      const meUid = lj.users && lj.users[0] && lj.users[0].localId;
      if(!meUid) return json(401, { error:'invalid login' });

      const body = await request.json();
      const type = body.type, toUid = String(body.toUid || '');
      if(!toUid || toUid === meUid || (type !== 'call' && type !== 'message')) return json(400, { error:'bad request' });

      const [sender, target] = await Promise.all([getDoc(env, 'users/' + meUid), getDoc(env, 'users/' + toUid)]);
      const name = sv(sender && sender.name) || 'ZimPro user';
      const photo = sv(sender && sender.photo); const smallPhoto = photo && photo.length < 400 ? photo : '';
      const tokens = ((target && target.fcmTokens && target.fcmTokens.arrayValue && target.fcmTokens.arrayValue.values) || []).map(v => v.stringValue).filter(Boolean);
      if(!tokens.length) return json(200, { sent:0, note:'recipient has no device registered' });

      let data, ttl;
      if(type === 'call'){
        const callId = String(body.callId || '');
        const c = await getDoc(env, 'calls/' + callId);
        if(!c) return json(404, { error:'no such call' });
        if(sv(c.callerId) !== meUid || sv(c.calleeId) !== toUid) return json(403, { error:'not your call' });
        if(sv(c.status) && sv(c.status) !== 'ringing') return json(200, { sent:0, note:'call no longer ringing' });
        data = { type:'call', callId, uid:meUid, name, photo:smallPhoto, video:(c.video && c.video.booleanValue) ? '1' : '0', ts:String(Date.now()) };
        ttl = 45;
      } else {
        const convId = String(body.convId || '');
        const cv = await getDoc(env, 'conversations/' + convId);
        if(!cv) return json(404, { error:'no such chat' });
        const parts = ((cv.participants && cv.participants.arrayValue && cv.participants.arrayValue.values) || []).map(v => v.stringValue);
        if(!parts.includes(meUid) || !parts.includes(toUid)) return json(403, { error:'not your chat' });
        data = { type:'message', convId, uid:meUid, name, title:name, body:clip(sv(cv.lastMessage) || 'New message', 140), photo:smallPhoto, ts:String(Date.now()) };
        ttl = 86400;
      }

      const sa = loadSA(env), at = await accessToken(env);
      const dead = []; let sent = 0;
      await Promise.all(tokens.map(async tk => {
        const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
          method:'POST', headers:{ Authorization:'Bearer ' + at, 'Content-Type':'application/json' },
          body:JSON.stringify({ message:{ token:tk, data, android:{ priority:'HIGH', ttl:ttl + 's' }, webpush:{ headers:{ Urgency:'high', TTL:String(ttl) } }, apns:{ headers:{ 'apns-priority':'10' } } } })
        });
        if(r.ok) sent++; else if(r.status === 404 || r.status === 400){ const t = await r.text(); if(/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(t)) dead.push(tk); }
      }));
      if(dead.length) await dropTokens(env, toUid, dead);
      return json(200, { sent, failed:tokens.length - sent });
    } catch(err){
      return json(500, { error:String(err && err.message || err) });
    }
  }
};
