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
    const key = auth.replace(/^Bearer\s+/i, '');
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
      let item;
      try { item = await req.json(); } catch (e) {
        // also accept ?amount=..&type=..&account=.. for simple Shortcuts
        item = Object.fromEntries(url.searchParams.entries());
      }
      const list = JSON.parse((await env.STORE.get('inbox')) || '[]');
      list.push({
        type: item.type || 'income',
        amount: item.amount,
        account: item.account || 'qDebit',
        detail: item.detail || 'From bank SMS',
        date: item.date || '',
        raw: item.raw || '',
        ts: Date.now(),
      });
      await env.STORE.put('inbox', JSON.stringify(list));
      return json({ ok: true, queued: list.length });
    }

    return json({ error: 'not found', path }, 404);
  },
};
