# SemanticDiff viewer assets

`webview/` is an unchanged copy of the SemanticDiff 0.10.0 Cursor extension's
`out/webview/` directory. `provenance.json` records the original file hashes.
Rust embeds this copy rather than reading viewer assets from a developer's
extension installation. The CLI and language parsers still come from
`SEMANTICDIFF_EXTENSION_DIR` during the build.

The original license and third-party notices accompany the files. These assets
are proprietary, not covered by this project's license. The supplied license
restricts copying, modification, redistribution, and providing the software as
a service; obtain the necessary permission before publishing these assets.

Keep application integration and optimizations in our TypeScript/Rust code so
the upstream viewer remains identifiable and its checksums can be verified.
