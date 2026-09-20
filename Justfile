set shell := ["zsh", "-cu"]

default: build

# Compile the React app and self-contained Rust executable.
build: frontend
    cargo build --release --target-dir .build

# Run the packaged-equivalent executable on its default 0.0.0.0:4317 listener.
run: package
    ./dist/local-diffe-darwin-arm64

# Produce the single-file macOS ARM64 distributable in dist/.
package: build
    mkdir -p dist
    cp .build/release/local-diffe dist/local-diffe-darwin-arm64
    codesign --force --sign - dist/local-diffe-darwin-arm64
    test "$(wc -c < dist/local-diffe-darwin-arm64)" -lt 50000000 || { echo "Release binary exceeds the 50 MB limit"; exit 1; }
    shasum -a 256 dist/local-diffe-darwin-arm64

# Print the deterministic Git-derived release version: <sha>+<YYYY.MM.DD>.
version: build
    ./.build/release/local-diffe --version

frontend:
    cd web && bun ci
    cd web && bun run build
