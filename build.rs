use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
};

const DEFAULT_SEMANTICDIFF_EXTENSION: &str =
    "/Users/abhishek/.cursor/extensions/semanticdiff.semanticdiff-0.10.0-darwin-arm64";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=SEMANTICDIFF_EXTENSION_DIR");
    println!("cargo:rerun-if-env-changed=LOCAL_DIFFE_VERSION");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let extension_dir = env::var_os("SEMANTICDIFF_EXTENSION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SEMANTICDIFF_EXTENSION));
    let web_dist = manifest_dir.join("web/dist");
    let semanticdiff_bin = extension_dir.join("bin/semanticdiff");
    let semanticdiff_parsers = extension_dir.join("bin");
    let semanticdiff_lib = extension_dir.join("lib");
    let semanticdiff_webview = manifest_dir.join("vendor/semanticdiff/webview");

    require_directory(
        &web_dist,
        "React build output is missing. Run `just frontend`.",
    );
    require_file(
        &semanticdiff_bin,
        "SemanticDiff CLI is missing. Set SEMANTICDIFF_EXTENSION_DIR to its Cursor extension directory.",
    );
    require_directory(
        &semanticdiff_webview,
        "Vendored SemanticDiff webview assets are missing from vendor/semanticdiff/webview.",
    );
    require_directory(
        &semanticdiff_lib,
        "SemanticDiff runtime libraries are missing from the Cursor extension.",
    );

    let embedded_dir = out_dir.join("embedded");
    let _ = fs::remove_dir_all(&embedded_dir);
    copy_tree(&web_dist, &embedded_dir.join("web")).expect("could not embed React assets");
    copy_tree(
        &semanticdiff_webview,
        &embedded_dir.join("semanticdiff-webview"),
    )
    .expect("could not embed SemanticDiff webview assets");
    let runtime_dir = embedded_dir.join("semanticdiff-runtime");
    compress_tree(&semanticdiff_parsers, &runtime_dir.join("bin"))
        .expect("could not embed SemanticDiff CLI and language parsers");
    compress_tree(&semanticdiff_lib, &runtime_dir.join("lib"))
        .expect("could not embed SemanticDiff runtime libraries");

    watch_tree(&web_dist).expect("could not watch React assets");
    watch_tree(&semanticdiff_webview).expect("could not watch SemanticDiff assets");
    watch_tree(&semanticdiff_parsers).expect("could not watch SemanticDiff parsers");
    watch_tree(&semanticdiff_lib).expect("could not watch SemanticDiff runtime libraries");
    println!("cargo:rerun-if-changed={}", semanticdiff_bin.display());
    println!("cargo:rustc-env=LOCAL_DIFFE_VERSION={}", release_version());
}

fn release_version() -> String {
    if let Ok(version) = env::var("LOCAL_DIFFE_VERSION") {
        return version;
    }
    let sha = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let date = git(&["show", "-s", "--format=%cs", "HEAD"])
        .unwrap_or_else(|| "1970-01-01".into())
        .replace('-', ".");
    format!("{sha}+{date}")
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn require_file(path: &Path, message: &str) {
    if !path.is_file() {
        panic!("{message}\nExpected: {}", path.display());
    }
}

fn require_directory(path: &Path, message: &str) {
    if !path.is_dir() {
        panic!("{message}\nExpected: {}", path.display());
    }
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

// Executable parsers dominate the bundle. Compress only the embedded copies;
// runtime extraction restores the original bytes before setting permissions.
fn compress_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            compress_tree(&entry.path(), &target)?;
        } else {
            let encoded = zstd::stream::encode_all(fs::File::open(entry.path())?, 9)?;
            fs::write(target, encoded)?;
        }
    }
    Ok(())
}

fn watch_tree(path: &Path) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let child = entry.path();
        if child.is_dir() {
            watch_tree(&child)?;
        } else {
            println!("cargo:rerun-if-changed={}", child.display());
        }
    }
    Ok(())
}
