set shell := ["zsh", "-cu"]

rust_toolchain := "1.99.0"

default: build

# Use pinned tools directly: shell-based cargo wrappers can strip DYLD variables.
# Compile the React app and self-contained Rust executable.
build: frontend
    sysroot="$(rustc +{{rust_toolchain}} --print sysroot)"; DYLD_LIBRARY_PATH="$sysroot/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" RUSTC="$sysroot/bin/rustc" "$sysroot/bin/cargo" build --release --target-dir .build

# Run the packaged-equivalent executable on its default 0.0.0.0:3333 listener.
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

# Run backend regression tests with the same toolchain and build workaround.
test:
    sysroot="$(rustc +{{rust_toolchain}} --print sysroot)"; DYLD_LIBRARY_PATH="$sysroot/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" RUSTC="$sysroot/bin/rustc" "$sysroot/bin/cargo" test --target-dir .build

# Run frontend unit and lint-policy regression tests.
test-frontend:
    cd web && bun run test

# Verify URL-driven review flows in Chrome, against built and development React.
test-browser: frontend
    cd web && bun run test:browser

# Enforce frontend correctness, React, accessibility, and vendored anti-slop rules.
lint-frontend:
    cd web && bun run lint

# Format owned frontend files; leave vendored sources unchanged.
fmt-frontend:
    cd web && bun run format

# Check frontend lint, formatting, types, and unit tests.
check-frontend:
    cd web && bun run check

# Check Rust formatting.
fmt-check:
    cargo +{{rust_toolchain}} fmt --check

frontend:
    cd web && bun ci
    cd web && bun run build
