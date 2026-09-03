use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, process::Command};
use tower_http::services::ServeDir;
use uuid::Uuid;

const DEFAULT_SEMANTICDIFF_BIN: &str =
    "/Users/abhishek/.cursor/extensions/semanticdiff.semanticdiff-0.10.0-darwin-arm64/bin/semanticdiff";
const DEFAULT_SEMANTICDIFF_WEBVIEW: &str =
    "/Users/abhishek/.cursor/extensions/semanticdiff.semanticdiff-0.10.0-darwin-arm64/out/webview";

#[derive(Parser, Debug)]
#[command(about = "A local viewer for Git patches using the installed SemanticDiff CLI")]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "0.0.0.0:4317")]
    listen: SocketAddr,

    /// Path to the SemanticDiff executable installed by Cursor.
    #[arg(long, env = "SEMANTICDIFF_BIN", default_value = DEFAULT_SEMANTICDIFF_BIN)]
    semanticdiff_bin: PathBuf,

    /// Unmodified webview directory from the installed SemanticDiff extension.
    #[arg(long, env = "SEMANTICDIFF_WEBVIEW", default_value = DEFAULT_SEMANTICDIFF_WEBVIEW)]
    semanticdiff_webview: PathBuf,

    /// React production build directory. Use `npm run build` in web/ before cargo run.
    #[arg(long, default_value = "web/dist")]
    web_dir: PathBuf,
}

#[derive(Clone)]
struct AppState {
    semanticdiff_bin: PathBuf,
    semanticdiff_webview: PathBuf,
    web_dir: PathBuf,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

#[derive(Clone)]
struct Session {
    repo: PathBuf,
    base: String,
    target: String,
    files: Vec<FileEntry>,
}

#[derive(Clone, Debug, Serialize)]
struct FileEntry {
    old_path: Option<String>,
    new_path: Option<String>,
    display_path: String,
    renderable: bool,
}

#[derive(Serialize)]
struct RevisionInfo {
    revision: String,
    commit: String,
}

#[derive(Serialize)]
struct ComparisonInfo {
    base: RevisionInfo,
    target: RevisionInfo,
    changed_paths: usize,
    semantic_paths: usize,
    description: String,
}

#[derive(Deserialize)]
struct StartRequest {
    patch: String,
    repo: String,
    base: String,
    target: String,
}

#[derive(Deserialize)]
struct GitDiffRequest {
    repo: String,
    base: String,
    target: String,
}

#[derive(Serialize)]
struct StartResponse {
    id: String,
    files: Vec<FileEntry>,
    comparison: Option<ComparisonInfo>,
}

#[derive(Serialize)]
struct SemanticResponse {
    file: FileEntry,
    old_content: String,
    new_content: String,
    semantic: Value,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    if !args.semanticdiff_bin.is_file() {
        eprintln!(
            "SemanticDiff executable not found: {}",
            args.semanticdiff_bin.display()
        );
        eprintln!("Install the SemanticDiff Cursor extension, or pass --semanticdiff-bin /path/to/semanticdiff");
        std::process::exit(2);
    }
    if !args.semanticdiff_webview.join("index.html").is_file() {
        eprintln!(
            "SemanticDiff webview not found: {}",
            args.semanticdiff_webview.display()
        );
        eprintln!("Pass --semanticdiff-webview /path/to/SemanticDiff/out/webview");
        std::process::exit(2);
    }

    let state = AppState {
        semanticdiff_bin: args.semanticdiff_bin,
        semanticdiff_webview: args.semanticdiff_webview.clone(),
        web_dir: args.web_dir.clone(),
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/api/patch", post(start_session))
        .route("/api/git-diff", post(start_git_diff))
        .route("/api/semantic/{id}/{index}", post(semantic_file))
        .route("/semanticdiff-view/{id}/{index}", get(semanticdiff_view))
        .nest_service("/assets", ServeDir::new(args.web_dir.join("assets")))
        .nest_service(
            "/semanticdiff-assets",
            ServeDir::new(args.semanticdiff_webview),
        )
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(args.listen).await.unwrap();
    println!("Local Diffe listening at http://{}", args.listen);
    axum::serve(listener, app).await.unwrap();
}

async fn index(State(state): State<AppState>) -> Html<String> {
    let fallback = "<main style=\"font-family:system-ui;padding:2rem\"><h1>Local Diffe</h1><p>Build the React app first: <code>cd web && npm run build</code></p></main>";
    Html(
        tokio::fs::read_to_string(state.web_dir.join("index.html"))
            .await
            .unwrap_or_else(|_| fallback.to_owned()),
    )
}

async fn start_session(
    State(state): State<AppState>,
    Json(request): Json<StartRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let repo = PathBuf::from(request.repo.trim());
    validate_git_input(&repo, &request.base, &request.target)?;
    create_session(
        state,
        repo,
        request.base,
        request.target,
        request.patch,
        None,
        None,
    )
}

async fn start_git_diff(
    State(state): State<AppState>,
    Json(request): Json<GitDiffRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let repo = PathBuf::from(request.repo.trim());
    validate_git_input(&repo, &request.base, &request.target)?;
    let base = request.base.trim().to_owned();
    let target = request.target.trim().to_owned();
    let (patch, mut files, base_commit, target_commit) = tokio::try_join!(
        git_diff(&repo, &base, &target),
        git_changed_files(&repo, &base, &target),
        git_commit(&repo, &base),
        git_commit(&repo, &target),
    )?;
    let patched_paths = parse_patch(&patch)
        .into_iter()
        .map(|file| file.display_path)
        .collect::<HashSet<_>>();
    for file in &mut files {
        file.renderable = patched_paths.contains(&file.display_path);
    }
    let semantic_paths = files.iter().filter(|file| file.renderable).count();
    let comparison = ComparisonInfo {
        base: RevisionInfo {
            revision: base.clone(),
            commit: base_commit,
        },
        target: RevisionInfo {
            revision: target.clone(),
            commit: target_commit,
        },
        changed_paths: files.len(),
        semantic_paths,
        description: "Committed snapshots only; uncommitted working-tree changes are excluded."
            .into(),
    };
    create_session(
        state,
        repo,
        base,
        target,
        patch,
        Some(files),
        Some(comparison),
    )
}

fn create_session(
    state: AppState,
    repo: PathBuf,
    base: String,
    target: String,
    patch: String,
    git_files: Option<Vec<FileEntry>>,
    comparison: Option<ComparisonInfo>,
) -> Result<Json<StartResponse>, ApiError> {
    let files = git_files.unwrap_or_else(|| parse_patch(&patch));
    if files.is_empty() {
        return Err(ApiError::bad_request(
            "No text file changes were found between these revisions.",
        ));
    }

    let id = Uuid::new_v4().to_string();
    let session = Session {
        repo,
        base: base.trim().to_owned(),
        target: target.trim().to_owned(),
        files: files.clone(),
    };
    state.sessions.lock().unwrap().insert(id.clone(), session);
    Ok(Json(StartResponse {
        id,
        files,
        comparison,
    }))
}

fn validate_git_input(repo: &PathBuf, base: &str, target: &str) -> Result<(), ApiError> {
    if !repo.is_dir() {
        return Err(ApiError::bad_request(format!(
            "Repository directory does not exist: {}",
            repo.display()
        )));
    }
    for revision in [base, target] {
        if revision.trim().is_empty() {
            return Err(ApiError::bad_request("Both Git revisions are required."));
        }
        if revision.starts_with('-') || revision.contains('\0') || revision.contains('\n') {
            return Err(ApiError::bad_request(
                "Git revisions must not start with `-` or contain newlines.",
            ));
        }
    }
    Ok(())
}

async fn git_diff(repo: &PathBuf, base: &str, target: &str) -> Result<String, ApiError> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(["diff", "--no-ext-diff", base, target])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not run git diff: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Could not diff `{base}` and `{target}`: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| ApiError::internal("git diff returned non-UTF-8 output."))
}

/// Read changed paths from Git's NUL-delimited machine format.  Patch headers are
/// intentionally not used here: an added empty file has no `---`/`+++` hunk even
/// though it is a real changed path.
async fn git_changed_files(
    repo: &PathBuf,
    base: &str,
    target: &str,
) -> Result<Vec<FileEntry>, ApiError> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(["diff", "--no-ext-diff", "--name-status", "-z", base, target])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not list changed files: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Could not list files between `{base}` and `{target}`: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    let fields = output
        .stdout
        .split(|byte| *byte == b'\0')
        .collect::<Vec<_>>();
    let mut index = 0;
    let mut files = Vec::new();
    while index < fields.len() {
        let status = fields[index];
        index += 1;
        if status.is_empty() {
            continue;
        }
        let status = std::str::from_utf8(status)
            .map_err(|_| ApiError::internal("Git returned a non-UTF-8 file name."))?;
        let takes_two_paths = status.starts_with('R') || status.starts_with('C');
        let first = fields
            .get(index)
            .ok_or_else(|| ApiError::internal("Git returned an incomplete file list."))?;
        index += 1;
        let first = std::str::from_utf8(first)
            .map_err(|_| ApiError::internal("Git returned a non-UTF-8 file name."))?
            .to_owned();
        let second = if takes_two_paths {
            let path = fields
                .get(index)
                .ok_or_else(|| ApiError::internal("Git returned an incomplete rename entry."))?;
            index += 1;
            Some(
                std::str::from_utf8(path)
                    .map_err(|_| ApiError::internal("Git returned a non-UTF-8 file name."))?
                    .to_owned(),
            )
        } else {
            None
        };
        let (old_path, new_path) = match status.chars().next() {
            Some('A') => (None, Some(first)),
            Some('D') => (Some(first), None),
            Some('R') | Some('C') => (Some(first), second),
            _ => (Some(first.clone()), Some(first)),
        };
        let display_path = new_path
            .clone()
            .or(old_path.clone())
            .unwrap_or_else(|| "unknown file".into());
        files.push(FileEntry {
            old_path,
            new_path,
            display_path,
            renderable: false,
        });
    }
    Ok(files)
}

async fn git_commit(repo: &PathBuf, revision: &str) -> Result<String, ApiError> {
    let expression = format!("{revision}^{{commit}}");
    let output = Command::new("git")
        .current_dir(repo)
        .args(["rev-parse", "--verify", &expression])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not resolve `{revision}`: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Could not resolve `{revision}` to a commit: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    String::from_utf8(output.stdout)
        .map(|commit| commit.trim().to_owned())
        .map_err(|_| ApiError::internal("Git returned a non-UTF-8 commit ID."))
}

async fn semantic_file(
    State(state): State<AppState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Json<SemanticResponse>, ApiError> {
    Ok(Json(compute_semantic(&state, &id, index).await?))
}

async fn semanticdiff_view(
    State(state): State<AppState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Html<String>, ApiError> {
    let result = compute_semantic(&state, &id, index).await?;
    let options = json!({
        "contextLines": 3,
        "hideComments": false,
        "compareMovedCode": true
    });
    let view_state = json!({
        "input": {
            "original": format!("file:///{}", result.file.old_path.as_deref().unwrap_or("/dev/null")),
            "modified": format!("file:///{}", result.file.new_path.as_deref().unwrap_or("/dev/null"))
        },
        "oldBreadcrumbs": result.file.old_path.as_deref().unwrap_or("/dev/null").split('/').collect::<Vec<_>>(),
        "breadcrumbs": result.file.new_path.as_deref().or(result.file.old_path.as_deref()).unwrap_or("/dev/null").split('/').collect::<Vec<_>>(),
        "title": result.file.display_path,
        "options": options,
        "threads": [],
        "viewerCanAddThread": false,
        "syntax": {
            "old": result.old_content,
            "new": result.new_content,
            "oldPath": result.file.old_path.clone().unwrap_or_default(),
            "newPath": result.file.new_path.clone().or(result.file.old_path.clone()).unwrap_or_default()
        },
        "patch": result.semantic,
        "remoteIsGitHubSSH": false,
        "suggestGitHubApp": false,
        "minimapMode": "detailed",
        "keepSelectionOnBlur": true
    });
    let state_json = serde_json::to_string(&view_state)
        .unwrap()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    let template = tokio::fs::read_to_string(state.semanticdiff_webview.join("index.html"))
        .await
        .map_err(|error| {
            ApiError::internal(format!("Could not read SemanticDiff webview: {error}"))
        })?;
    let bridge = r#"<style>:root{color-scheme:dark;--vscode-font-family:ui-sans-serif,system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:ui-monospace,SFMono-Regular,Menlo,monospace;--vscode-editor-font-size:12px;--vscode-editor-background:#0d1117;--vscode-editor-foreground:#e6edf3;--vscode-breadcrumb-background:#161b22;--vscode-breadcrumb-foreground:#c9d1d9;--vscode-breadcrumb-focusForeground:#58a6ff;--vscode-editorWidget-border:#30363d;--vscode-scrollbar-shadow:#010409;--vscode-focusBorder:#58a6ff;--vscode-button-background:#238636;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#2ea043;--vscode-input-background:#0d1117;--vscode-input-foreground:#e6edf3;--vscode-list-activeSelectionBackground:#1f6feb;--vscode-list-hoverBackground:#21262d;--vscode-diffEditor-insertedLineBackground:#033a16;--vscode-diffEditor-removedLineBackground:#67060c;--vscode-diffEditor-insertedTextBackground:#0f6b2e;--vscode-diffEditor-removedTextBackground:#8e1519;--vscode-diffEditor-diagonalFill:#30363d;--vscode-minimapSlider-background:#8b949e99;--vscode-peekViewResult-background:#161b22;--vscode-editorOverviewRuler-modifiedForeground:#58a6ff;--vscode-editorOverviewRuler-deletedForeground:#f85149;--vscode-editorOverviewRuler-addedForeground:#3fb950;--vscode-editorLineNumber-foreground:#8b949e;--vscode-editorUnicodeHighlight-background:#6e40c933;--vscode-editorUnicodeHighlight-border:#6e40c9;--vscode-editor-selectionBackground:#264f78;--vscode-notifications-background:#161b22;--vscode-notifications-border:#30363d;--vscode-notifications-foreground:#c9d1d9;--vscode-notificationsErrorIcon-foreground:#f85149;--vscode-disabledForeground:#8b949e;--vscode-icon-foreground:#c9d1d9;--vscode-editorCodeLens-foreground:#8b949e;--vscode-editorGhostText-foreground:#8b949e;--vscode-editorHint-foreground:#8b949e;--vscode-editorInlayHint-background:#21262d;--vscode-editorLink-activeForeground:#58a6ff;--vscode-editorSuggestWidget-foreground:#c9d1d9;--vscode-editorSuggestWidget-selectedForeground:#fff;--vscode-editorWidget-background:#161b22;--vscode-menu-selectionBackground:#1f6feb;--vscode-menu-selectionForeground:#fff;--vscode-statusBar-background:#161b22;--vscode-statusBar-foreground:#c9d1d9;--vscode-statusBarItem-hoverBackground:#21262d;--vscode-statusBarItem-hoverForeground:#fff;--vscode-toolbar-activeBackground:#30363d;--vscode-toolbar-hoverBackground:#21262d;--vscode-tree-tableColumnsBorder:#30363d;--vscode-tree-tableOddRowsBackground:#161b22}html,body{background:#0d1117!important;color:#e6edf3!important}.patch,.patch .line,.patch .code-fg,.patch .line .content,.patch .header{color:#c9d1d9!important}.patch .line .line-number,.patch .line .number{color:#8b949e!important}</style><script>window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:(message)=>window.parent!==window&&window.parent.postMessage({source:'semanticdiff',message},'*')});</script><script src="script.js"></script>"#;
    let html = template
        .replace("${webview.cspSource}", "'self'")
        .replace("${baseURL}", "/semanticdiff-assets")
        .replace("${ initialState }", &state_json)
        .replace(
            "<script src=\"script.js\"></script>",
            &bridge.replace(
                r#"<script src="script.js"></script>"#,
                r#"<script type="module">import{decorateSemanticPatch}from"/assets/semantic-highlight.js";try{await decorateSemanticPatch(initialState.patch,initialState.syntax)}catch(error){console.warn("Shiki highlighting unavailable",error)}const script=document.createElement("script");script.src="script.js";document.body.append(script)</script>"#,
            ),
        );
    Ok(Html(html))
}

async fn compute_semantic(
    state: &AppState,
    id: &str,
    index: usize,
) -> Result<SemanticResponse, ApiError> {
    let session = state
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| {
            ApiError::bad_request("This browser session has expired; load the patch again.")
        })?;
    let file = session
        .files
        .get(index)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("Unknown patch file index."))?;

    let old_content = match &file.old_path {
        Some(path) => git_show(&session.repo, &session.base, path).await?,
        None => String::new(),
    };
    let new_content = match &file.new_path {
        Some(path) => git_show(&session.repo, &session.target, path).await?,
        None => String::new(),
    };

    let extension = file
        .new_path
        .as_ref()
        .or(file.old_path.as_ref())
        .and_then(|path| std::path::Path::new(path).extension())
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    let request = json!({
        "old_content": old_content,
        "new_content": new_content,
        "extension": extension,
        "fallback": true,
        "options": { "ignore_comments": false }
    });
    let semantic = run_semanticdiff(&state.semanticdiff_bin, request).await?;

    Ok(SemanticResponse {
        file,
        old_content,
        new_content,
        semantic,
    })
}

async fn git_show(repo: &PathBuf, revision: &str, path: &str) -> Result<String, ApiError> {
    let object = format!("{revision}:{path}");
    let output = Command::new("git")
        .current_dir(repo)
        .args(["show", &object])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not run git: {error}")))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ApiError::bad_request(format!(
            "Could not read `{object}` from {}: {details}",
            repo.display()
        )));
    }
    String::from_utf8(output.stdout).map_err(|_| {
        ApiError::bad_request(format!(
            "`{object}` is not UTF-8 text and cannot be rendered."
        ))
    })
}

async fn run_semanticdiff(bin: &PathBuf, input: Value) -> Result<Value, ApiError> {
    let mut child = Command::new(bin)
        .arg("--diff-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ApiError::internal(format!("Could not start SemanticDiff: {error}")))?;
    let payload = serde_json::to_vec(&input).unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&payload)
        .await
        .map_err(|error| {
            ApiError::internal(format!("Could not send input to SemanticDiff: {error}"))
        })?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| ApiError::internal(format!("SemanticDiff did not finish: {error}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: Value = serde_json::from_str(&stdout).map_err(|error| {
        ApiError::internal(format!(
            "SemanticDiff returned invalid JSON ({error}): {stdout}"
        ))
    })?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "SemanticDiff could not parse this file: {result}"
        )));
    }
    Ok(result)
}

fn parse_patch(patch: &str) -> Vec<FileEntry> {
    let mut files = Vec::new();
    let mut current: Option<FileEntry> = None;

    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            if let Some(file) = current.take().filter(has_a_path) {
                files.push(file);
            }
            current = Some(FileEntry {
                old_path: None,
                new_path: None,
                display_path: "unknown file".into(),
                renderable: true,
            });
        } else if let Some(file) = current.as_mut() {
            if let Some(path) = line.strip_prefix("--- ") {
                file.old_path = patch_path(path, 'a');
            } else if let Some(path) = line.strip_prefix("+++ ") {
                file.new_path = patch_path(path, 'b');
                file.display_path = file
                    .new_path
                    .clone()
                    .or(file.old_path.clone())
                    .unwrap_or_else(|| "unknown file".into());
            }
        }
    }
    if let Some(file) = current.filter(has_a_path) {
        files.push(file);
    }
    files
}

fn has_a_path(file: &FileEntry) -> bool {
    file.old_path.is_some() || file.new_path.is_some()
}

fn patch_path(header: &str, prefix: char) -> Option<String> {
    let path = header.split('\t').next().unwrap_or(header);
    if path == "/dev/null" {
        return None;
    }
    path.strip_prefix(&format!("{prefix}/")).map(str::to_owned)
}
