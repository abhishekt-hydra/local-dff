# Local UI checks with Rustwright

Install once:

```bash
cd local-debug
npm install
```

`Rustwright` drives a locally installed Chromium/Chrome through CDP. The helper
defaults to macOS Google Chrome. Override it with `RUSTWRIGHT_CHROMIUM=/path/to/chrome`.

Run the complete screenshot flow (it builds the frontend and temporarily starts
the Rust server):

```bash
./run-capture.sh
```

The captures appear in `local-debug/screenshots/`:

- `01-landing.png`
- `02-file-tree.png`
- `03-semantic-view.png`
- `04-desktop-semantic.png` (from `npm run desktop`)

With the Rust app already running, the focused scripts are:

```bash
npm run capture
FILE_INDEX=12 npm run semantic
npm run theme
```

`theme` prints computed host and SemanticDiff iframe colors so contrast errors
are caught alongside the visual screenshot review.
