// The live match counter. GET /api/matches returns { count }. POST /api/matches adds one match and returns { count }.
// The count lives in the D1 database that wrangler.toml binds as DB, and `UPDATE ... SET n = n + 1` is atomic.
// A POST from one address counts at most once per 25 s: the shortest match, AUTO only, takes 30 s. The address is
// stored only as a hash with a secret salt that never leaves the database, and rows older than a day are deleted.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const count = async db => (await db.prepare("SELECT n FROM counter WHERE name = 'matches'").first('n')) ?? 0;

export async function onRequestGet({ env }) { return json({ count: await count(env.DB) }); }

export async function onRequestPost({ env, request }) {
  const db = env.DB, now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT OR IGNORE INTO secret (name, value) VALUES ('salt', ?)").bind(crypto.randomUUID()).run();
  const salt = await db.prepare("SELECT value FROM secret WHERE name = 'salt'").first('value'), ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`)), who = [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  // The upsert changes a row only if this visitor's last counted match is at least 25 s old, so `changes` says whether to count.
  const seen = await db.prepare('INSERT INTO recent (who, at) VALUES (?1, ?2) ON CONFLICT(who) DO UPDATE SET at = ?2 WHERE recent.at <= ?2 - 25').bind(who, now).run();
  if (seen.meta.changes > 0) await db.batch([db.prepare("UPDATE counter SET n = n + 1 WHERE name = 'matches'"), db.prepare('DELETE FROM recent WHERE at < ?').bind(now - 86400)]);
  return json({ count: await count(db), counted: seen.meta.changes > 0 });
}
