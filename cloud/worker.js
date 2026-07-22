/* My Money — cloud sync + SMS inbox (Cloudflare Worker)
   Storage: KV namespace bound as STORE
     key "state"     -> full app JSON (pushed by the app)
     key "updatedAt" -> ms timestamp of last state write
     key "inbox"     -> JSON array of pending adds from the phone (bank SMS)
   Auth: every request must carry the shared secret (env.SECRET) via
     Authorization: Bearer <secret>   OR   ?key=<secret>
*/
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const auth = req.headers.get('Authorization') || url.searchParams.get('key') || '';
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    if (!env.SECRET || key !== env.SECRET) return json({ error: 'unauthorized' }, 401);

    const path = url.pathname.replace(/\/+$/, '') || '/';

    // ---- full state sync (app) ----
    if (path === '/state') {
      if (req.method === 'GET') {
        const s = await env.STORE.get('state');
        const updatedAt = await env.STORE.get('updatedAt');
        return json({ state: s ? JSON.parse(s) : null, updatedAt: updatedAt ? +updatedAt : 0 });
      }
      if (req.method === 'PUT') {
        const body = await req.text();
        await env.STORE.put('state', body);
        await env.STORE.put('updatedAt', '' + Date.now());
        return json({ ok: true });
      }
    }

    // ---- pending adds from the phone (bank SMS) ----
    if (path === '/inbox') {
      if (req.method === 'GET') {
        const i = await env.STORE.get('inbox');
        return json({ inbox: i ? JSON.parse(i) : [] });
      }
      if (req.method === 'DELETE') {
        await env.STORE.put('inbox', '[]');
        return json({ ok: true });
      }
    }

    // ---- add one transaction from the Shortcut ----
    // body: { type:"income"|"expense", amount:Number|String, account, detail, date, raw }
    if (path === '/add' && req.method === 'POST') {
      const ct = (req.headers.get('content-type') || '').toLowerCase();
      const q = Object.fromEntries(url.searchParams.entries());   // e.g. ?account=qDebit&category=Food
      let item;
      if (ct.includes('application/json')) {
        try { item = { ...q, ...(await req.json()) }; } catch (e) { item = q; }
      } else {
        // plain-text body IS the bank message (simplest Shortcut)
        const bodyText = await req.text();
        item = { ...q, raw: (bodyText && bodyText.trim()) || q.raw || '' };
      }
      const list = JSON.parse((await env.STORE.get('inbox')) || '[]');
      list.push({
        type: item.type || '',            // empty → the app decides debit/credit from the raw text
        amount: item.amount != null ? item.amount : '',
        account: item.account || 'qDebit',
        detail: item.detail || '',
        category: item.category || '',
        date: item.date || '',
        raw: item.raw || '',
        ts: Date.now(),
      });
      await env.STORE.put('inbox', JSON.stringify(list));
      return json({ ok: true, queued: list.length });
    }

    // ---- daily backups ----
    // POST /backup           -> snapshot current state as backup:<today>
    // GET  /backups          -> list of backup dates (newest first)
    // GET  /backup?date=YYYY-MM-DD -> a specific snapshot
    if (path === '/backup' && req.method === 'POST') {
      const date = new Date().toISOString().slice(0, 10);
      const s = await env.STORE.get('state');
      if (s) await env.STORE.put('backup:' + date, s);
      await pruneBackups(env, 30);
      return json({ ok: true, date, saved: !!s });
    }
    if (path === '/backups' && req.method === 'GET') {
      const list = await env.STORE.list({ prefix: 'backup:' });
      const dates = list.keys.map(k => k.name.slice('backup:'.length)).sort().reverse();
      return json({ backups: dates });
    }
    if (path === '/backup' && req.method === 'GET') {
      const date = url.searchParams.get('date') || '';
      const s = await env.STORE.get('backup:' + date);
      return json({ date, state: s ? JSON.parse(s) : null });
    }

    return json({ error: 'not found', path }, 404);
  },

  // runs on the daily cron trigger — snapshot current state
  async scheduled(event, env, ctx) {
    const s = await env.STORE.get('state');
    if (s) {
      const date = new Date().toISOString().slice(0, 10);
      await env.STORE.put('backup:' + date, s);
    }
    await pruneBackups(env, 30);
  },
};

// keep only the newest `keep` daily backups
async function pruneBackups(env, keep) {
  const list = await env.STORE.list({ prefix: 'backup:' });
  const names = list.keys.map(k => k.name).sort();     // ascending by date (oldest first)
  const excess = names.length - keep;
  for (let i = 0; i < excess; i++) await env.STORE.delete(names[i]);
}
