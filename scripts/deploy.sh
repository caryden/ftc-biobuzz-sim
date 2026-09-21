#!/bin/sh
# Deploys the site to Cloudflare Pages, and only to the account that you name.
# Run: CF_ACCOUNT_NAME="Your Account" sh scripts/deploy.sh [project-name]
# The account name can also go in a file named .deploy.env next to package.json, which git ignores:
#   CF_ACCOUNT_NAME="Your Account"
#   CF_PAGES_PROJECT="your-project"
# The guard exists because `wrangler login` can hold a login to another account: the script refuses to deploy unless
# `wrangler whoami` lists the named account, and it passes that account's ID to every wrangler call.
set -e
case "${1:-}" in -*) echo "Usage: sh scripts/deploy.sh [project-name]. The argument is a Cloudflare Pages project name, not an option." >&2; exit 2;; esac
[ -f .deploy.env ] && . ./.deploy.env
ACCOUNT="${CF_ACCOUNT_NAME:?Set CF_ACCOUNT_NAME to the name of your Cloudflare account, or put it in .deploy.env}"
PROJECT="${1:-${CF_PAGES_PROJECT:-biobuzz-sim}}"
WHO="$(wrangler whoami 2>&1)"
LINE="$(printf '%s\n' "$WHO" | grep -F "$ACCOUNT" || true)"
if [ -z "$LINE" ]; then
  echo "Refusing to deploy: wrangler can't see the \"$ACCOUNT\" account. It sees:" >&2
  printf '%s\n' "$WHO" | grep -E '^│' | grep -v 'Account Name' | sed -E 's/[a-f0-9]{28}([a-f0-9]{4})/…\1/' >&2
  echo "Run \`wrangler login\` and include that account, and then run this script again." >&2; exit 1
fi
ID="$(printf '%s\n' "$LINE" | grep -oE '[a-f0-9]{32}')"
python3 scripts/build-site.py
npm run build
export CLOUDFLARE_ACCOUNT_ID="$ID"
# functions/ holds the Pages Functions, and wrangler.toml binds the D1 database of the match counter.
# The first deploy creates the Pages project. Later deploys reuse it.
wrangler pages project list 2>/dev/null | grep -q "$PROJECT" || wrangler pages project create "$PROJECT" --production-branch main
wrangler pages deploy dist --project-name "$PROJECT" --branch main
