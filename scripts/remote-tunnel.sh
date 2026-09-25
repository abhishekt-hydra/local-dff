#!/usr/bin/env bash
# Forward localhost:8766 to the remote Local Diffe server. Ctrl-C to stop.
set -euo pipefail

HOST="${LOCAL_DIFFE_HOST:-aws-xlarge}"
REMOTE_PORT="${LOCAL_DIFFE_REMOTE_PORT:-8766}"
LOCAL_PORT="${LOCAL_DIFFE_LOCAL_PORT:-$REMOTE_PORT}"

echo "Open http://localhost:$LOCAL_PORT  (Ctrl-C to close the tunnel)"
exec ssh -N -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" "$HOST"
