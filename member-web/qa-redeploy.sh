#!/usr/bin/env bash
# Rebuild the member-web bundle and drop it into the running demo server's
# public dir (api/public), so http://localhost:3942 serves the latest UI.
# The admin bundle under api/public/admin is left untouched.
set -euo pipefail
cd "$(dirname "$0")"
npm run build >/tmp/qa-build.log 2>&1 || { echo "BUILD FAILED"; tail -20 /tmp/qa-build.log; exit 1; }
rm -f ../api/public/index.html ../api/public/favicon.svg
rm -rf ../api/public/assets
cp -r dist/* ../api/public/
echo "redeployed to api/public"
