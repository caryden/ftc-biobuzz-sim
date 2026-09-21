// The live match counter.
//   GET  /api/matches             returns { count, countries }: the matches, and how many countries they came from.
//   GET  /api/matches?by=country  returns { count, countries, byCountry: [{ code, n }] }, most matches first.
//   POST /api/matches             adds one finished match and returns { count, countries, counted }.
// The counts live in the D1 database that wrangler.toml binds as DB, and `UPDATE ... SET n = n + 1` is atomic.
// A POST from one address counts at most once per 25 s: the shortest match, AUTO only, takes 30 s. The address is
// stored only as a hash with a secret salt that never leaves the database, and rows older than a day are deleted.
// The country is the two-letter code that Cloudflare attaches to the request (request.cf.country). It is stored as a
// count per country, with nothing about the visitor.
// A preview deployment has no DB binding, so that a pull request's preview can't change the real count.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const totals = async db => {
  const [count, countries] = await db.batch([db.prepare("SELECT n FROM counter WHERE name = 'matches'"), db.prepare('SELECT COUNT(*) AS c FROM countries')]);
  return { count: count.results[0]?.n ?? 0, countries: countries.results[0]?.c ?? 0 };
};

export async function onRequestGet({ env, request }) {
  if (!env.DB) return json({ count: null, countries: null });
  const out = await totals(env.DB);
  if (new URL(request.url).searchParams.get('by') === 'country') out.byCountry = (await env.DB.prepare('SELECT code, n FROM countries ORDER BY n DESC, code').all()).results;
  return json(out);
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ count: null, countries: null, counted: false });
  const db = env.DB, now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT OR IGNORE INTO secret (name, value) VALUES ('salt', ?)").bind(crypto.randomUUID()).run();
  const salt = await db.prepare("SELECT value FROM secret WHERE name = 'salt'").first('value'), ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`)), who = [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  // The upsert changes a row only if this visitor's last counted match is at least 25 s old, so `changes` says whether to count.
  const seen = await db.prepare('INSERT INTO recent (who, at) VALUES (?1, ?2) ON CONFLICT(who) DO UPDATE SET at = ?2 WHERE recent.at <= ?2 - 25').bind(who, now).run();
  if (seen.meta.changes > 0) {
    const work = [db.prepare("UPDATE counter SET n = n + 1 WHERE name = 'matches'"), db.prepare('DELETE FROM recent WHERE at < ?').bind(now - 86400)];
    // XX means that Cloudflare has no country for the address, and T1 is the Tor network. Neither is a country.
    const code = request.cf?.country; if (typeof code === 'string' && /^[A-Z]{2}$/.test(code) && code !== 'XX') work.push(db.prepare('INSERT INTO countries (code, n) VALUES (?, 1) ON CONFLICT(code) DO UPDATE SET n = n + 1').bind(code));
    await db.batch(work);
  }
  return json({ ...(await totals(db)), counted: seen.meta.changes > 0 });
}
