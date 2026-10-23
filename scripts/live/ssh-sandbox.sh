#!/bin/sh
# Starts a throwaway sshd on 127.0.0.1:2222 that stands in for a remote machine (same OS user, key auth only,
# TCP forwarding DISABLED — AgentRoom must not need it). Needs root and the OpenSSH server package.
#   scripts/live/ssh-sandbox.sh up|down
set -e
D=/tmp/agentroom-ssh
case "$1" in
up)
  mkdir -p "$D" /run/sshd "$HOME/.ssh"
  [ -f "$D/host_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -f "$D/host_ed25519"
  [ -f "$D/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -f "$D/id_ed25519"
  cp "$D/id_ed25519.pub" "$D/authorized_keys"
  cat > "$D/sshd_config" <<CFG
Port 2222
ListenAddress 127.0.0.1
HostKey $D/host_ed25519
PidFile $D/sshd.pid
AuthorizedKeysFile $D/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
UsePAM no
StrictModes no
AllowTcpForwarding no
PermitUserEnvironment yes
LogLevel ERROR
CFG
  # A real remote machine has its own login and network. In a sandbox where Claude is configured through the
  # environment, hand those variables to ssh sessions (single-line values only).
  env | grep -E '^(ANTHROPIC_|CLAUDE_|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE)[A-Za-z0-9_]*=' > "$HOME/.ssh/environment" || true
  chmod 600 "$HOME/.ssh/environment"
  # the host key is deliberately NOT in known_hosts yet: the first connection must fail with advice
  sed -i '/^\[127.0.0.1\]:2222 /d' "$HOME/.ssh/known_hosts" 2>/dev/null || true
  /usr/sbin/sshd -f "$D/sshd_config"
  sleep 1
  echo "sshd up on 127.0.0.1:2222, key $D/id_ed25519"
  ;;
trust)
  ssh-keyscan -p 2222 127.0.0.1 2>/dev/null >> "$HOME/.ssh/known_hosts"
  ;;
down)
  [ -f "$D/sshd.pid" ] && kill "$(cat "$D/sshd.pid")" 2>/dev/null || true
  sed -i '/^\[127.0.0.1\]:2222 /d' "$HOME/.ssh/known_hosts" 2>/dev/null || true
  rm -f "$HOME/.ssh/environment"
  ;;
esac
