// =====================================================================
//  AM CHAT — Cloudflare Worker للإشعارات (Push)
//  يستلم طلب من الموقع بعد كل رسالة، ويدز إشعار لكل أعضاء المحادثة
//  حتى لو التطبيق مسدود عندهم.
//  الإعداد: Settings › Variables › أضف Secret اسمه SERVICE_ACCOUNT
//  وحط بيه محتوى ملف JSON مال حساب الخدمة من Firebase كامل.
//  تصميم وبرمجة علي مالك
// =====================================================================
let TOKEN = null, TOKEN_EXP = 0, JWKS = null, JWKS_EXP = 0;

const enc = new TextEncoder();
const b64u = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64uStr = s => b64u(enc.encode(s));
const fromB64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };

// قراءة قيم Firestore REST
const dv = v => {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return +v.integerValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dv);
  if ('mapValue' in v) { const o = {}, f = v.mapValue.fields || {}; for (const k in f) o[k] = dv(f[k]); return o; }
  return null;
};
const docOf = d => (d && d.fields ? dv({ mapValue: { fields: d.fields } }) : null);

async function accessToken(sa) {
  if (TOKEN && Date.now() < TOKEN_EXP - 60000) return TOKEN;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + b64u(sig)
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth: ' + JSON.stringify(j));
  TOKEN = j.access_token; TOKEN_EXP = Date.now() + j.expires_in * 1000;
  return TOKEN;
}

// التأكد إن الطلب جاي من مستخدم مسجّل دخول حقيقي
async function verifyIdToken(tok, pid) {
  const [h, p, s] = (tok || '').split('.');
  if (!s) throw new Error('no token');
  const head = JSON.parse(new TextDecoder().decode(fromB64u(h)));
  const pl = JSON.parse(new TextDecoder().decode(fromB64u(p)));
  const t = Date.now() / 1000;
  if (pl.aud !== pid || pl.iss !== 'https://securetoken.google.com/' + pid || pl.exp < t || !pl.sub) throw new Error('bad token');
  if (!JWKS || Date.now() > JWKS_EXP) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    JWKS = (await r.json()).keys; JWKS_EXP = Date.now() + 3600e3;
  }
  const jwk = JWKS.find(k => k.kid === head.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64u(s), enc.encode(h + '.' + p));
  if (!ok) throw new Error('bad signature');
  return pl.sub;
}

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('AM CHAT push worker ✓ شغّال', { headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });
    try {
      if (!env.SERVICE_ACCOUNT) throw new Error('SERVICE_ACCOUNT secret missing');
      const sa = JSON.parse(env.SERVICE_ACCOUNT), pid = sa.project_id;
      const uid = await verifyIdToken((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), pid);
      const { cid, mid } = await req.json();
      if (!cid || !mid) throw new Error('missing cid/mid');
      const at = await accessToken(sa);
      const base = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/`;
      const H = { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' };
      const get = async p => { const r = await fetch(base + p, { headers: H }); return r.ok ? docOf(await r.json()) : null; };

      const [chat, msg, sender] = await Promise.all([get('chats/' + cid), get(`chats/${cid}/messages/${mid}`), get('users/' + uid)]);
      if (!chat || !msg || msg.from !== uid || !(chat.members || []).includes(uid)) return json({ ok: false, error: 'forbidden' }, 403);

      const name = (sender && sender.name) || 'AM CHAT';
      let prev = msg.type === 'image' ? '📷 ' + (msg.text || 'صورة') : msg.type === 'voice' ? '🎤 بصمة صوت' : (msg.text || '');
      if (msg.story) prev = '↩️ رد على قصتك: ' + prev;
      if (msg.type === 'system' || !prev) return json({ ok: true, sent: 0 });
      const group = chat.type === 'group';
      const title = group ? (chat.title || 'مجموعة') : name;
      const body = group ? `${name}: ${prev}` : prev;

      const unreadTotal = async m => {
        try {
          const r = await fetch(base.replace(/\/documents\/$/, '/documents:runQuery'), {
            method: 'POST', headers: H,
            body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'chats' }], where: { fieldFilter: { field: { fieldPath: 'members' }, op: 'ARRAY_CONTAINS', value: { stringValue: m } } }, limit: 300 } })
          });
          let n = 0; for (const x of await r.json()) { const d = x.document && docOf(x.document); if (d && d.unread && d.unread[m] > 0) n++; }
          return Math.max(1, n);
        } catch (e) { return 1; }
      };

      let sent = 0;
      await Promise.all((chat.members || []).filter(u => u !== uid).map(async m => {
        const [u, pr, tk] = await Promise.all([get('users/' + m), get('prefs/' + m), get('pushTokens/' + m)]);
        if (pr && (pr.muted || []).includes(cid)) return;                         // كاتم المحادثة
        if (u && u.online && Date.now() - (u.lastSeen || 0) < 70000) return;      // فاتح التطبيق هسه
        const all = (tk && tk.tokens) || {}; const toks = Object.keys(all);
        if (!toks.length) return;
        const badge = await unreadTotal(m), dead = [];
        await Promise.all(toks.map(async t => {
          const r = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {
            method: 'POST', headers: H,
            body: JSON.stringify({ message: { token: t,
              data: { title: String(title).slice(0, 80), body: String(body).slice(0, 180), cid, tag: cid, badge: String(badge), icon: 'icon-192.png' },
              webpush: { headers: { Urgency: 'high', TTL: '86400' } } } })
          });
          if (r.ok) sent++; else { const txt = await r.text(); if (/UNREGISTERED|NOT_FOUND|registration-token-not-registered/.test(txt)) dead.push(t); }
        }));
        if (dead.length) { // نشيل التوكنات المنتهية
          const keep = {}; toks.filter(t => !dead.includes(t)).forEach(t => keep[t] = { integerValue: String(Math.round(+all[t] || 0)) });
          await fetch(base + 'pushTokens/' + m + '?updateMask.fieldPaths=tokens', { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { tokens: { mapValue: { fields: keep } } } }) });
        }
      }));
      return json({ ok: true, sent });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 400);
    }
  }
};
