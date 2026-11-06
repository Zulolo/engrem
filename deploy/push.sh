#!/usr/bin/env bash
# Push the committed code to the box running EngRem in hosted mode and restart
# the service there. Only committed files are sent (git archive HEAD); the
# box's data folder and /etc/engrem/env are untouched.
#
#   bash deploy/push.sh [user@host]        default: orangepi@hifi-server.local
#
# First-time setup on the box (once, needs the sudo password):
#   git archive HEAD | ssh user@host 'mkdir -p ~/engrem-src && tar -x -C ~/engrem-src'
#   ssh -t user@host 'sudo bash ~/engrem-src/deploy/install.sh --public-url https://... --tunnel-token ...'
set -Eeuo pipefail
HOST="${1:-orangepi@hifi-server.local}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rev="$(git rev-parse --short HEAD)"
echo "==> sending $rev to $HOST:/opt/engrem"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar HEAD server.js hosted.js index.html sample_wordbook.xml README.md LICENSE deploy \
  | ssh "$HOST" 'tar -x -C /opt/engrem && echo '"$rev"' > /opt/engrem/.deployed-rev && sudo -n systemctl restart engrem && sleep 1.5 && curl -fsS http://127.0.0.1:8017/healthz && echo && sudo -n systemctl status engrem --no-pager | head -5'
