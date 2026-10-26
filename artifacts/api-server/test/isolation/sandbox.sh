#!/bin/sh
# Isolation session: runs a command inside a private network namespace (loopback only), in its
# own process group that is killed at teardown,
# with a clean environment (env -i), a Node preload that records any outbound attempt,
# and a PostgreSQL 18 cluster created for this session and destroyed afterwards.
#
#   test/isolation/sandbox.sh <command> [args...]
#
# Required: DINAR_ISOLATION_ROOT (an empty scratch directory) and DINAR_PG18_BIN.
# Optional: DINAR_ISOLATION_PASS (space-separated names of extra non-secret variables to keep).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SELF="$HERE/sandbox.sh"
STAGE=${1:-}

case "$STAGE" in
  __netns)
    shift
    # Root inside the new user+network namespace: bring loopback up, then drop back to the
    # caller's uid in a nested user namespace (PostgreSQL refuses to run as root).
    python3 - <<'EOF'
import socket, fcntl, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
def up(name):
    ifr = struct.pack('16sH14s', name, 0, b'')
    flags = struct.unpack('16sH14s', fcntl.ioctl(s, 0x8913, ifr))[1]
    fcntl.ioctl(s, 0x8914, struct.pack('16sH14s', name, flags | 1, b''))
def addr(name, request, value):
    fcntl.ioctl(s, request, struct.pack('16sH2s4s8s', name, socket.AF_INET, b'\0' * 2, socket.inet_aton(value), b'\0' * 8))
up(b'lo')
# An address-only interface with a host mask and no routes: Chromium then reports
# navigator.onLine=true (the chat composer disables itself offline), while every
# non-loopback destination stays unreachable. The preflight verifies both.
addr(b'sit0', 0x8916, '10.255.255.1')
addr(b'sit0', 0x891c, '255.255.255.255')
up(b'sit0')
EOF
    # Lets the unprivileged session bind the third-party stub on 443 (namespaced sysctl).
    echo 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start
    exec unshare --user --map-user="$DINAR_OUTER_UID" "$SELF" __session "$@"
    ;;
  __session)
    shift
    ROOT=$DINAR_ISOLATION_ROOT
    export PGDATA="$ROOT/pgdata" PGHOST=127.0.0.1 PGPORT=55432 PGUSER=dinar_isolation
    export DINAR_ISOLATION_PGDATA="$PGDATA" DINAR_ISOLATION_NET_LOG="$ROOT/net-attempts.log"
    export NODE_OPTIONS="--import=file://$HERE/net-guard.mjs"
    # Per-session random signing key; the caller's SESSION_SECRET never enters the sandbox.
    SESSION_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n'); export SESSION_SECRET
    : > "$DINAR_ISOLATION_NET_LOG"
    stop() {
      # Teardown always runs to the end: no step may abort it under set -e.
      set +e
      # Everything the command left behind shares its process group (a PID namespace would be
      # stronger, but /proc cannot be remounted here and Chromium then loads no page).
      [ -n "${COMMAND_PID:-}" ] && kill -KILL "-$COMMAND_PID" 2>/dev/null
      [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
      pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
      rm -rf "$PGDATA"
      echo "ISOLATION_TEARDOWN: cluster stopped, $PGDATA removed"
    }
    trap stop EXIT
    # The outer stage guaranteed an empty root, so everything removed here was created here.
    initdb -D "$PGDATA" -U "$PGUSER" --auth=trust -E UTF8 --locale=C.UTF-8 >"$ROOT/initdb.log" 2>&1
    pg_ctl -D "$PGDATA" -l "$ROOT/postgres.log" -w \
      -o "-c listen_addresses=127.0.0.1 -c port=$PGPORT -c unix_socket_directories='' -c max_connections=200" start >/dev/null
    createdb dinar_isolation_sentinel
    psql -d dinar_isolation_sentinel -qc "create table isolation_sentinel(nonce text not null, data_dir text not null, created_at timestamptz default now()); insert into isolation_sentinel(nonce, data_dir) values ('$DINAR_ISOLATION_SESSION', current_setting('data_directory'))"
    echo "ISOLATION_SESSION: $(psql -d dinar_isolation_sentinel -Atqc 'select version()' | cut -d, -f1) on $PGHOST:$PGPORT"
    if [ -n "${REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
      # Browser suites: the web app's only runtime third-party origin (Google Fonts) is served
      # by a local stub; Chromium trusts exactly that stub's key and nothing else.
      openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=sandbox-third-party" \
        -addext "subjectAltName=DNS:fonts.googleapis.com,DNS:fonts.gstatic.com" \
        -keyout "$ROOT/stub.key" -out "$ROOT/stub.crt" >/dev/null 2>&1
      SPKI=$(openssl x509 -in "$ROOT/stub.crt" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
      export DINAR_ISOLATION_STUB_LOG="$ROOT/third-party-stub.log"
      : > "$DINAR_ISOLATION_STUB_LOG"
      NODE_OPTIONS= node "$HERE/third-party-stub.mjs" "$ROOT/stub.crt" "$ROOT/stub.key" 443 "$DINAR_ISOLATION_STUB_LOG" &
      STUB_PID=$!
      REAL_CHROMIUM=$REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
      cat > "$ROOT/chromium" <<WRAPPER
#!/bin/sh
exec "$REAL_CHROMIUM" --host-resolver-rules="MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1" --ignore-certificate-errors-spki-list="$SPKI" "\$@"
WRAPPER
      chmod +x "$ROOT/chromium"
      # Both names browser suites read (dinar/test/*-ui-acceptance.mjs use CHROMIUM_PATH).
      export REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE="$ROOT/chromium" CHROMIUM_PATH="$ROOT/chromium"
    fi
    node "$HERE/preflight.mjs"
    status=0
    # setsid: the command leads a new process group (its pid), so teardown can end all of it.
    setsid "$@" &
    COMMAND_PID=$!
    wait "$COMMAND_PID" || status=$?
    if [ -s "$DINAR_ISOLATION_NET_LOG" ]; then
      echo "ISOLATION_NET: FAIL — outbound attempts recorded:" >&2
      cat "$DINAR_ISOLATION_NET_LOG" >&2
      cp "$DINAR_ISOLATION_NET_LOG" "$ROOT/net-attempts.retained.log"
      [ "$status" -eq 0 ] && status=98
    else
      echo "ISOLATION_NET: PASS (0 outbound attempts)"
    fi
    exit "$status"
    ;;
esac

: "${DINAR_ISOLATION_ROOT:?set DINAR_ISOLATION_ROOT to a scratch directory}"
: "${DINAR_PG18_BIN:?set DINAR_PG18_BIN to a PostgreSQL 18 bin directory}"
# Teardown deletes the session cluster under this root, so the root must be new or empty:
# a pre-existing pgdata (or anything else) is never touched.
if [ -e "$DINAR_ISOLATION_ROOT" ] && [ -n "$(ls -A "$DINAR_ISOLATION_ROOT")" ]; then
  echo "ISOLATION: DINAR_ISOLATION_ROOT must be an empty directory; refusing $DINAR_ISOLATION_ROOT" >&2
  exit 96
fi
mkdir -p "$DINAR_ISOLATION_ROOT/home"
NODE_DIR=$(dirname "$(command -v node)")
PNPM_DIR=$(dirname "$(command -v pnpm)")
NONCE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
PASS=""
for name in ${DINAR_ISOLATION_PASS:-}; do
  eval "value=\${$name:-}"
  PASS="$PASS $name=$value"
done
# shellcheck disable=SC2086
exec env -i \
  PATH="$DINAR_PG18_BIN:$NODE_DIR:$PNPM_DIR:$(dirname "$(command -v python3)"):/usr/bin:/bin" \
  HOME="$DINAR_ISOLATION_ROOT/home" LANG=C.UTF-8 TZ=UTC \
  DINAR_OUTER_UID="$(id -u)" DINAR_ISOLATION_ROOT="$DINAR_ISOLATION_ROOT" DINAR_ISOLATION_SESSION="$NONCE" \
  $PASS \
  unshare -rn "$SELF" __netns "$@"
