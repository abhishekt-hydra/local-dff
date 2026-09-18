#!/usr/bin/env bash
# Install Git, GitHub CLI, and Rust, then configure GitHub CLI access on Linux.
set -euo pipefail

skip_gh_auth=false
if [[ "${1:-}" == "--skip-gh-auth" ]]; then
  skip_gh_auth=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--skip-gh-auth]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This bootstrap script supports Linux only." >&2
  exit 1
fi

command -v sudo >/dev/null || {
  echo "sudo is required to install system packages." >&2
  exit 1
}

install_apt() {
  sudo apt-get update
  sudo apt-get install -y git curl ca-certificates
  if ! command -v gh >/dev/null; then
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
      sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
      sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y gh
  fi
}

install_dnf() {
  sudo dnf install -y git curl ca-certificates
  if ! command -v gh >/dev/null; then
    sudo dnf install -y 'dnf-command(config-manager)'
    if ! sudo dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo; then
      sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
    fi
    sudo dnf install -y gh
  fi
}

install_pacman() {
  sudo pacman -S --needed --noconfirm git curl github-cli
}

install_zypper() {
  sudo zypper --non-interactive install git curl github-cli
}

if command -v apt-get >/dev/null; then
  install_apt
elif command -v dnf >/dev/null; then
  install_dnf
elif command -v pacman >/dev/null; then
  install_pacman
elif command -v zypper >/dev/null; then
  install_zypper
else
  echo "Unsupported Linux package manager. Install git, gh, curl, and Rust manually." >&2
  exit 1
fi

if command -v cargo >/dev/null && command -v rustc >/dev/null; then
  echo "Rust is already installed."
else
  echo "Installing Rust with rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

if [[ -f "$HOME/.cargo/env" ]]; then
  # Make cargo/rustc available to this script immediately; new shells source it normally.
  source "$HOME/.cargo/env"
fi

command -v cargo >/dev/null || {
  echo "Rust installation completed, but cargo is not on PATH. Open a new terminal and run this script again." >&2
  exit 1
}

if [[ "$skip_gh_auth" == false ]]; then
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "GitHub CLI is already authenticated for github.com."
  else
    echo "Opening GitHub CLI login. Sign in in the browser; choose or create an SSH key when prompted."
    gh auth login --hostname github.com --web --git-protocol ssh
  fi
  gh auth setup-git
else
  echo "Skipped GitHub CLI authentication. Run 'gh auth login --web --git-protocol ssh' before using GitHub PR features."
fi

echo
echo "Bootstrap complete."
echo "Verify GitHub access with: gh auth status"
