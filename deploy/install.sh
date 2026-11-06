#!/usr/bin/env bash
# Install or update EngRem as a systemd service on a Debian-based box
# (Orange Pi, Raspberry Pi, any arm64/amd64 Debian 12+). Idempotent: run it
# again after every code push.
#
#   sudo bash deploy/install.sh [--public-url https://engrem.example.com]
#                               [--lan-url http://box.local:8017]
#                               [--tunnel-token <cloudflare tunnel token>]
#
# What it does:
#   - Node.js 22 from NodeSource when node is missing or older than 18
#   - unprivileged user `engrem`, code in /opt/engrem (readable by all),
#     data in /var/lib/engrem (wordbooks, caches, state, auth.json)
#   - /etc/engrem/env (created once; edit it to change the URLs or port)
#   - engrem.service enabled and (re)started
#   - with --tunnel-token: cloudflared installed as a service (http2 transport)
#   - the invoking sudo user may `systemctl restart engrem` without a password,
#     so deploy/push.sh can redeploy over SSH
set -Eeuo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

PUBLIC_URL="" LAN_URL="" TUNNEL_TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --lan-url) LAN_URL="$2"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/engrem
DATA=/var/lib/engrem
ENV=/etc/engrem/env
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# --- Node.js ---------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  v="$(node -v | sed 's/^v//' | cut -d. -f1)"; [ "$v" -ge 18 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  log "Installing Node.js 22 (NodeSource)"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "node $(node -v) at $(command -v node)"
[ -x /usr/bin/node ] || ln -sf "$(command -v node)" /usr/bin/node

# --- user, folders, code ---------------------------------------------------
id -u engrem >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin engrem
mkdir -p "$APP" "$DATA" /etc/engrem
if [ "$SRC" != "$APP" ]; then
  log "Copying code to $APP"
  for f in server.js hosted.js index.html sample_wordbook.xml README.md LICENSE; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$APP/"
  done
  mkdir -p "$APP/deploy" && cp "$SRC"/deploy/* "$APP/deploy/"
fi
# the deploying user owns the code folder (push.sh untars there without sudo)
DEPLOYER="${SUDO_USER:-root}"
chown -R "$DEPLOYER":"$DEPLOYER" "$APP"
chmod -R a+rX "$APP"
chown -R engrem:engrem "$DATA"
chmod 750 "$DATA"

# --- environment -----------------------------------------------------------
if [ ! -f "$ENV" ]; then
  log "Writing $ENV"
  cat > "$ENV" <<EOF
# EngRem hosted mode — edit and \`systemctl restart engrem\`
ENGREM_HOSTED=1
ENGREM_DATA=$DATA
ENGREM_PORT=8017
ENGREM_BIND=0.0.0.0
# the address behind the tunnel (used for the LAN -> public sign-in hand-off)
ENGREM_PUBLIC_URL=${PUBLIC_URL}
# the address on the home network, shown on the login page as the fallback
ENGREM_LAN_URL=${LAN_URL:-http://$(hostname).local:8017}
EOF
  chmod 640 "$ENV"; chown root:engrem "$ENV"
else
  [ -n "$PUBLIC_URL" ] && sed -i "s#^ENGREM_PUBLIC_URL=.*#ENGREM_PUBLIC_URL=$PUBLIC_URL#" "$ENV"
  [ -n "$LAN_URL" ] && sed -i "s#^ENGREM_LAN_URL=.*#ENGREM_LAN_URL=$LAN_URL#" "$ENV"
fi

# --- service ---------------------------------------------------------------
log "Installing engrem.service"
cp "$APP/deploy/engrem.service" /etc/systemd/system/engrem.service
cat > /etc/sudoers.d/engrem-deploy <<EOF
$DEPLOYER ALL=(root) NOPASSWD: /usr/bin/systemctl restart engrem, /usr/bin/systemctl stop engrem, /usr/bin/systemctl start engrem, /usr/bin/systemctl status engrem *, /usr/bin/journalctl -u engrem *
EOF
chmod 440 /etc/sudoers.d/engrem-deploy
systemctl daemon-reload
systemctl enable engrem >/dev/null 2>&1
systemctl restart engrem
sleep 1.5
if curl -fsS -o /dev/null http://127.0.0.1:"$(grep -E '^ENGREM_PORT=' "$ENV" | cut -d= -f2)"/healthz; then
  log "engrem.service is up"
else
  journalctl -u engrem -n 20 --no-pager; echo "engrem did not answer on /healthz" >&2; exit 1
fi

# --- Cloudflare Tunnel (optional) -----------------------------------------
if [ -n "$TUNNEL_TOKEN" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    arch="$(dpkg --print-architecture)"
    log "Installing cloudflared ($arch)"
    curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
    dpkg -i /tmp/cloudflared.deb >/dev/null && rm -f /tmp/cloudflared.deb
  fi
  if systemctl list-unit-files | grep -q '^cloudflared.service'; then
    log "cloudflared.service already installed — replacing the token"
    cloudflared service uninstall >/dev/null 2>&1 || true
  fi
  log "Installing cloudflared.service"
  cloudflared service install "$TUNNEL_TOKEN"
  # QUIC does not pass every router/Wi-Fi; http2 always does
  mkdir -p /etc/systemd/system/cloudflared.service.d
  printf '[Service]\nEnvironment=TUNNEL_TRANSPORT_PROTOCOL=http2\n' > /etc/systemd/system/cloudflared.service.d/override.conf
  systemctl daemon-reload
  systemctl enable cloudflared >/dev/null 2>&1 || true
  systemctl restart cloudflared
  log "cloudflared running: $(systemctl is-active cloudflared)"
fi

log "Done. Sign in once from the home network; the initial password must be changed at first login."
