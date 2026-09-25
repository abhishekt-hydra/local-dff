#!/usr/bin/env bash
# Ship the current HEAD commit to the remote host, then rebuild and run the
# release binary in the tmux session "local-diffe-deploy" (listening on the
# remote's 127.0.0.1:$LOCAL_DIFFE_REMOTE_PORT; reach it via remote-tunnel.sh).
#
#   scripts/remote-deploy.sh           # deploy, return immediately
#   scripts/remote-deploy.sh --attach  # deploy, then attach to the tmux session
#   scripts/remote-deploy.sh --logs    # only attach to the running session
set -euo pipefail

HOST="${LOCAL_DIFFE_HOST:-aws-xlarge}"
SESSION=local-diffe-deploy
REMOTE_DIR=local-diffe/src            # relative to the remote $HOME
PORT="${LOCAL_DIFFE_REMOTE_PORT:-8766}"

attach=false
case "${1:-}" in
  "") ;;
  --attach) attach=true ;;
  --logs) exec ssh -t "$HOST" tmux attach -t "$SESSION" ;;
  *) echo "Usage: $0 [--attach|--logs]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
sha="$(git -C "$root" rev-parse --short=12 HEAD)"
# Same format build.rs derives from git, which the exported tree lacks.
version="$sha+$(git -C "$root" show -s --format=%cs HEAD | tr - .)"
[[ -z "$(git -C "$root" status --porcelain)" ]] ||
  echo "warning: uncommitted changes are NOT deployed; shipping HEAD ($sha) only" >&2

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git -C "$root" archive HEAD | tar -x -C "$stage"

echo "==> Syncing $version to $HOST:~/$REMOTE_DIR"
ssh "$HOST" mkdir -p "$REMOTE_DIR"
# Excluded build outputs survive --delete, so rebuilds stay incremental.
rsync -az --delete \
  --exclude /.build/ --exclude /web/node_modules/ --exclude /web/dist/ \
  "$stage/" "$HOST:$REMOTE_DIR/"
# The runner comes from the working tree so deploy tooling works for any commit.
rsync -az "$root/scripts/remote-run.sh" "$HOST:local-diffe/remote-run.sh"

echo "==> Restarting tmux session $SESSION"
# The trailing shell keeps the pane open if the build or server exits.
ssh "$HOST" "tmux kill-session -t $SESSION 2>/dev/null || true
  tmux new-session -d -s $SESSION -c ~/$REMOTE_DIR \
    'LOCAL_DIFFE_VERSION=$version LOCAL_DIFFE_REMOTE_PORT=$PORT bash ~/local-diffe/remote-run.sh; exec bash'"

echo "Building in tmux ($HOST: tmux attach -t $SESSION)."
echo "Then run scripts/remote-tunnel.sh and open http://localhost:$PORT"
if [[ "$attach" == true ]]; then
  exec ssh -t "$HOST" tmux attach -t "$SESSION"
fi
