#!/usr/bin/env bash
# One-time setup of the remote build host (Ubuntu, aarch64 or x86_64):
# system packages, gh, bun, Rust, the Linux SemanticDiff extension, and a
# dedicated GitHub SSH key for this server.
#
#   scripts/remote-setup.sh              # install toolchain + create SSH key
#   scripts/remote-setup.sh --gh-login   # interactive: gh login + upload key
set -euo pipefail

HOST="${LOCAL_DIFFE_HOST:-aws-xlarge}"
SEMANTICDIFF_VERSION="${SEMANTICDIFF_VERSION:-0.10.0}"

if [[ "${1:-}" == "--gh-login" ]]; then
  # Device-code login (open the printed URL on your laptop), then upload the
  # server's own key so git over SSH works without your laptop connected.
  exec ssh -t "$HOST" 'set -e
    gh auth status --hostname github.com >/dev/null 2>&1 ||
      gh auth login --hostname github.com --git-protocol ssh --web \
        --skip-ssh-key --scopes admin:public_key
    gh ssh-key add ~/.ssh/github-server.pub --title "$(hostname)-local-diffe" ||
      echo "(key upload failed or key already present)"
    ssh -T git@github.com-hydra || true'
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--gh-login]" >&2
  exit 2
fi

ssh "$HOST" SEMANTICDIFF_VERSION="$SEMANTICDIFF_VERSION" bash -s <<'REMOTE'
set -euo pipefail

echo "==> System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential pkg-config git curl unzip rsync tmux ca-certificates

if ! command -v gh >/dev/null; then
  echo "==> GitHub CLI"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
    sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh
fi

if [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  echo "==> bun"
  curl -fsSL https://bun.sh/install | bash
fi

if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  echo "==> Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

case "$(uname -m)" in
  aarch64) platform=linux-arm64 ;;
  x86_64) platform=linux-x64 ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
ext_root="$HOME/semanticdiff-ext"
if [[ ! -x "$ext_root/extension/bin/semanticdiff" || "$(cat "$ext_root/.version" 2>/dev/null)" != "$SEMANTICDIFF_VERSION-$platform" ]]; then
  echo "==> SemanticDiff $SEMANTICDIFF_VERSION ($platform)"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/ext.vsix" \
    "https://open-vsx.org/api/semanticdiff/semanticdiff/$platform/$SEMANTICDIFF_VERSION/file/semanticdiff.semanticdiff-$SEMANTICDIFF_VERSION@$platform.vsix"
  rm -rf "$ext_root"
  mkdir -p "$ext_root"
  unzip -q "$tmp/ext.vsix" 'extension/*' -d "$ext_root"
  chmod -R u+x "$ext_root/extension/bin"
  echo "$SEMANTICDIFF_VERSION-$platform" > "$ext_root/.version"
  rm -rf "$tmp"
fi

echo "==> GitHub SSH key"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[[ -f ~/.ssh/github-server ]] ||
  ssh-keygen -t ed25519 -N '' -C "$(whoami)@$(hostname)-github" -f ~/.ssh/github-server
touch ~/.ssh/config && chmod 600 ~/.ssh/config
# Both aliases: plain github.com and the github.com-hydra alias the repo remote uses.
for alias in github.com github.com-hydra; do
  grep -qE "^Host $alias\$" ~/.ssh/config || cat >> ~/.ssh/config <<EOF

Host $alias
    HostName github.com
    User git
    IdentityFile ~/.ssh/github-server
    IdentitiesOnly yes
EOF
done
ssh-keygen -F github.com >/dev/null || ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
git config --global user.name >/dev/null || echo "note: git user.name not set on server (only needed to commit)"

echo
echo "Setup complete."
gh auth status --hostname github.com >/dev/null 2>&1 &&
  echo "gh: authenticated" || echo "gh: NOT authenticated -> run scripts/remote-setup.sh --gh-login"
REMOTE
