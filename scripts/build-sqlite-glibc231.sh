#!/usr/bin/env bash
# Builds the linux-x64 glibc prebuild of @appthreat/sqlite3 against glibc 2.31 (Ubuntu 20.04), so `durable` storage loads on
# Ubuntu 20.04 / Debian 11. Runs in its own container; it never prunes images or touches other containers on the host.
#   scripts/build-sqlite-glibc231.sh [output-dir]
# Needs: docker (a running daemon), network access to nodejs.org and the npm registry.
set -euo pipefail

OUT="${1:-$PWD/sqlite-glibc231}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').dependencies['@appthreat/sqlite3']")"
NODE_VERSION="${NODE_VERSION:-20.18.0}"
IMAGE="ubuntu:20.04"
mkdir -p "$OUT"

docker run --rm -v "$OUT":/out -e VERSION="$VERSION" -e NODE_VERSION="$NODE_VERSION" "$IMAGE" bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq build-essential python3 curl xz-utils ca-certificates binutils gcc-10 g++-10 >/dev/null
  # Ubuntu 20.04 ships gcc 9, which rejects -std=gnu++20 used by this addon. gcc 10 does not raise the glibc requirement.
  export CC=gcc-10 CXX=g++-10

  # Node from the official tarball: it runs on glibc 2.31 and builds N-API addons against its own headers.
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt
  export PATH="/opt/node-v${NODE_VERSION}-linux-x64/bin:$PATH"

  work=/work && mkdir -p "$work" && cd "$work"
  npm pack "@appthreat/sqlite3@${VERSION}" --silent >/dev/null
  tar -xzf "appthreat-sqlite3-${VERSION}.tgz"
  cd package
  npm install --ignore-scripts --no-audit --no-fund >/dev/null
  npx --yes prebuildify@6 --napi --strip --tag-libc --arch x64 --target "${NODE_VERSION}" >/dev/null

  built="$(ls prebuilds/linux-x64/*.node | head -1)"
  # The highest glibc symbol the binary needs must be 2.31 or lower, or it will not load on the target.
  need="$(objdump -T "$built" | grep -o "GLIBC_2\.[0-9]*" | sort -uV | tail -1)"
  echo "highest glibc symbol: ${need}"
  if [ "$(printf "%s\n%s\n" "$need" "GLIBC_2.31" | sort -V | tail -1)" != "GLIBC_2.31" ]; then
    echo "FAIL: binary needs ${need}, above 2.31" >&2; exit 1
  fi
  cp "$built" /out/@appthreat+sqlite3.glibc.node
'

cd "$OUT"
sha256sum "@appthreat+sqlite3.glibc.node" | tee SHA256SUMS
echo "built ${VERSION} for glibc 2.31 -> $OUT"
