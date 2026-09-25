#!/usr/bin/env bash
# Runs ON the remote host inside the tmux session started by remote-deploy.sh:
# builds the frontend and release binary, then serves on localhost only.
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
# Pin a toolchain rather than trusting the host's rustup default.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export SEMANTICDIFF_EXTENSION_DIR="${SEMANTICDIFF_EXTENSION_DIR:-$HOME/semanticdiff-ext/extension}"
port="${LOCAL_DIFFE_REMOTE_PORT:-8766}"

echo "==> Frontend"
(cd web && bun ci && bun run build)

echo "==> Release build ($LOCAL_DIFFE_VERSION)"
cargo build --release --target-dir .build

echo "==> Serving on 127.0.0.1:$port"
exec ./.build/release/local-diffe --listen "127.0.0.1:$port"
