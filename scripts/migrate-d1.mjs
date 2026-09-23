// Applies the D1 migrations in migrations/ to the production database. `npm run build` runs it last, so it runs only
// after the site builds. It does nothing except in a Cloudflare Pages build of `main`: a preview build, a local
// build, and CI skip it. It needs CLOUDFLARE_API_TOKEN, with D1 edit permission, and CLOUDFLARE_ACCOUNT_ID, set in the
// Pages project's production environment variables only.
// A migration must be additive, such as a new table or a new column, because the old deployment keeps running
// against the new schema until the new one goes live.
import { spawnSync } from 'node:child_process';

const { CF_PAGES, CF_PAGES_BRANCH, CLOUDFLARE_API_TOKEN } = process.env;
if (CF_PAGES !== '1' || CF_PAGES_BRANCH !== 'main') {
  console.log(`D1 migrations: skipped, because this isn't a Pages build of main (branch: ${CF_PAGES_BRANCH ?? 'none'}).`);
  process.exit(0);
}
if (!CLOUDFLARE_API_TOKEN) {
  console.warn('D1 migrations: SKIPPED. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the production environment variables of the Pages project.');
  process.exit(0);
}
// The version is pinned, so that every build runs the same Wrangler. A failed migration fails the build, so the new
// code never goes live on the old schema.
const r = spawnSync('npx', ['--yes', 'wrangler@4.136.3', 'd1', 'migrations', 'apply', 'DB', '--remote'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
