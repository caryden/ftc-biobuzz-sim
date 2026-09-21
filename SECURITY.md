# Security

The site is static, apart from one endpoint: `functions/api/matches.js` counts finished matches in a Cloudflare D1
database. It stores no accounts and no personal data. It keeps a salted hash of a visitor's address for one day, to
limit how fast one address can raise the count.

The repository holds no credentials. `wrangler.toml` contains a D1 database ID, which is an identifier and not a
secret: using it needs a Cloudflare login.

To report a vulnerability, open an issue. If the report shouldn't be public, say only that you have one, and a
maintainer will give you a private channel.
