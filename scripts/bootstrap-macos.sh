#!/usr/bin/env bash
# Install Git, GitHub CLI, and Rust, then configure GitHub CLI access on macOS.
# The packaged executable only needs Git; Rust is included for source builds.
set -euo pipefail

skip_gh_auth=false
if [[ "${1:-}" == "--skip-gh-auth" ]]; then
  skip_gh_auth=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--skip-gh-auth]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This bootstrap script supports macOS only." >&2
  exit 1
fi

command -v curl >/dev/null || {
  echo "curl is required to install Homebrew and Rust." >&2
  exit 1
}

if ! command -v brew >/dev/null; then
  echo "Installing Homebrew (you may be prompted for your password)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
else
  echo "Homebrew was installed but could not be found on PATH." >&2
  exit 1
fi

install_formula() {
  local command_name="$1"
  local formula="$2"
  if command -v "$command_name" >/dev/null; then
    echo "$command_name is already installed."
  else
    echo "Installing $formula..."
    brew install "$formula"
  fi
}

install_formula git git
install_formula gh gh

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
