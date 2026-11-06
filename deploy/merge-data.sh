#!/usr/bin/env bash
# On the hosted box: fold an uploaded data archive into /var/lib/engrem.
#
#   sudo bash /opt/engrem/deploy/merge-data.sh /tmp/engrem-data.tgz [--dry-run]
#
# The archive is what deploy/MERGE.md tells the other PC to make (state.json,
# examples-cache.json, phonetic-cache.json, audio-cache/, image-cache/, *.xml
# at its top level). The service is stopped during the merge, the current
# data folder is backed up to /var/backups first, and merge-data.js does the
# merging (target wins, source adds). Run with --dry-run to see the summary
# without changing anything.
set -Eeuo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
ARCHIVE="${1:?archive path required}"; shift || true
DATA=/var/lib/engrem
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d /tmp/engrem-merge.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
[ -f "$TMP/state.json" ] || [ -f "$TMP/examples-cache.json" ] || { echo "archive has no EngRem data at its top level" >&2; exit 1; }

if [[ " $* " == *" --dry-run "* ]]; then
  node "$APP/deploy/merge-data.js" --from "$TMP" --into "$DATA" --dry-run
  exit 0
fi
mkdir -p /var/backups
BACKUP="/var/backups/engrem-$(date +%Y%m%d-%H%M%S).tgz"
tar -czf "$BACKUP" -C "$DATA" .
echo "backup: $BACKUP"
systemctl stop engrem
node "$APP/deploy/merge-data.js" --from "$TMP" --into "$DATA"
chown -R engrem:engrem "$DATA"
systemctl start engrem
sleep 1.5
curl -fsS http://127.0.0.1:8017/healthz >/dev/null && echo "engrem is back up" || { journalctl -u engrem -n 20 --no-pager; exit 1; }
