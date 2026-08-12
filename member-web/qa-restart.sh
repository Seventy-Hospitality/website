#!/usr/bin/env bash
# Restart the running demo API server so @fastify/static (wildcard:false)
# re-globs api/public and picks up freshly-hashed bundle assets. Run after
# qa-redeploy.sh, because the server only serves asset files that existed at
# its startup.
set -uo pipefail
cd "$(dirname "$0")/../api"

# Stop whatever holds :3942
PIDS=$(fuser 3942/tcp 2>/dev/null || true)
if [ -n "${PIDS}" ]; then
  kill ${PIDS} 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    fuser 3942/tcp >/dev/null 2>&1 || break
    sleep 0.3
  done
  fuser -k 3942/tcp 2>/dev/null || true
fi

DATABASE_URL="postgresql://postgres:verify@localhost:55441/club70?schema=public" \
JWT_SECRET="demo-secret-0123456789abcdef" \
PORT=3942 \
  setsid node dist/src/server.js >/tmp/qa-server.log 2>&1 &

# Wait until it answers
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://localhost:3942/api/health"; then
    echo "demo server up on :3942"
    exit 0
  fi
  sleep 0.3
done
echo "SERVER DID NOT COME UP"; tail -20 /tmp/qa-server.log; exit 1
