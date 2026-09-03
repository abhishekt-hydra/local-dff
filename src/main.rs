use std::{
    collections::{HashMap, HashSet},
    fs,
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use directories::ProjectDirs;
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, process::Command};
use uuid::Uuid;

static WEB_ASSETS: Dir<'_> = include_dir!("$OUT_DIR/embedded/web");
static SEMANTICDIFF_WEBVIEW: Dir<'_> = include_dir!("$OUT_DIR/embedded/semanticdiff-webview");
static SEMANTICDIFF_RUNTIME: Dir<'_> = include_dir!("$OUT_DIR/embedded/semanticdiff-runtime");

#[derive(Parser, Debug)]
#[command(
    version = env!("LOCAL_DIFFE_VERSION"),
    about = "A self-contained local viewer for Git patches using SemanticDiff"
)]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "0.0.0.0:4317")]
    listen: SocketAddr,
}

#[derive(Clone)]
struct AppState {
    semanticdiff_bin: PathBuf,
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
    pull_request: Option<PullRequestInfo>,
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

#[derive(Deserialize)]
struct GitHubPullsRequest {
    repo: String,
}

#[derive(Deserialize)]
struct GitHubCompareRequest {
    repo: String,
    number: u64,
}

#[derive(Deserialize)]
struct GitHubUrlRequest {
    repo: String,
    url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PullRequestInfo {
    number: u64,
    title: String,
    url: String,
    state: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    #[serde(rename = "baseRefOid", default)]
    base_ref_oid: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "headRefOid", default)]
    head_ref_oid: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    author: Option<PullRequestAuthor>,
    #[serde(rename = "updatedAt", default)]
    updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PullRequestAuthor {
    login: String,
}

#[derive(Deserialize)]
struct GitHubRepoInfo {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

#[derive(Debug)]
struct GitHubPrReference {
    repo: String,
    number: u64,
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
    let semanticdiff_bin = extract_semanticdiff().unwrap_or_else(|error| {
        eprintln!("Could not prepare embedded SemanticDiff: {error}");
        std::process::exit(2);
    });

    let state = AppState {
        semanticdiff_bin,
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/assets/{*path}", get(web_asset))
        .route("/api/patch", post(start_session))
        .route("/api/git-diff", post(start_git_diff))
        .route("/api/github/open-prs", post(github_open_prs))
        .route("/api/github/compare", post(github_compare_pr))
        .route("/api/github/open-url", post(github_open_url))
        .route("/api/semantic/{id}/{index}", post(semantic_file))
        .route("/semanticdiff-view/{id}/{index}", get(semanticdiff_view))
        .route("/semanticdiff-assets/{*path}", get(semanticdiff_asset))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(args.listen).await.unwrap();
    println!("Local Diffe listening at http://{}", args.listen);
    axum::serve(listener, app).await.unwrap();
}

async fn index() -> Html<&'static str> {
    Html(asset_text(&WEB_ASSETS, "index.html").expect("embedded web index is missing"))
}

async fn web_asset(Path(path): Path<String>) -> Response {
    embedded_asset(&WEB_ASSETS, &format!("assets/{path}"))
}

async fn semanticdiff_asset(Path(path): Path<String>) -> Response {
    embedded_asset(&SEMANTICDIFF_WEBVIEW, &path)
}

fn embedded_asset(directory: &'static Dir<'static>, path: &str) -> Response {
    let Some(file) = directory.get_file(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from(file.contents()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(path)),
    );
    response
}

fn asset_text(directory: &'static Dir<'static>, path: &str) -> Option<&'static str> {
    std::str::from_utf8(directory.get_file(path)?.contents()).ok()
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn extract_semanticdiff() -> Result<PathBuf, String> {
    let directories = ProjectDirs::from("com", "hydradb", "local-diffe")
        .ok_or_else(|| "could not determine a local cache directory".to_owned())?;
    let runtime = directories
        .cache_dir()
        .join("semanticdiff")
        .join(env!("LOCAL_DIFFE_VERSION"))
        .join("runtime");
    let destination = runtime.join("bin/semanticdiff");
    if runtime.join(".complete").is_file() && destination.is_file() {
        return Ok(destination);
    }

    let parent = runtime
        .parent()
        .ok_or_else(|| "could not construct SemanticDiff cache path".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create cache directory: {error}"))?;
    let temporary = parent.join(format!(".runtime-{}.tmp", std::process::id()));
    let _ = fs::remove_dir_all(&temporary);
    materialize_embedded_dir(&SEMANTICDIFF_RUNTIME, &temporary)?;
    fs::write(temporary.join(".complete"), env!("LOCAL_DIFFE_VERSION"))
        .map_err(|error| format!("could not finalize embedded SemanticDiff: {error}"))?;
    let _ = fs::remove_dir_all(&runtime);
    fs::rename(&temporary, &runtime)
        .map_err(|error| format!("could not activate embedded SemanticDiff: {error}"))?;
    Ok(destination)
}

fn materialize_embedded_dir(
    source: &'static Dir<'static>,
    destination: &std::path::Path,
) -> Result<(), String> {
    source
        .extract(destination)
        .map_err(|error| format!("could not write embedded SemanticDiff files: {error}"))?;
    #[cfg(unix)]
    if let Some(bin) = source.get_dir("bin") {
        use std::os::unix::fs::PermissionsExt;
        for file in bin.files() {
            let target = destination.join(file.path());
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).map_err(|error| {
                format!("could not make SemanticDiff parser executable: {error}")
            })?;
        }
    }
    Ok(())
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
    create_git_comparison(
        state,
        repo,
        base,
        target,
        None,
        "Committed snapshots only; uncommitted working-tree changes are excluded.".into(),
    )
    .await
}

async fn create_git_comparison(
    state: AppState,
    repo: PathBuf,
    base: String,
    target: String,
    pull_request: Option<PullRequestInfo>,
    description: String,
) -> Result<Json<StartResponse>, ApiError> {
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
        description,
        pull_request,
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

async fn github_open_prs(
    Json(request): Json<GitHubPullsRequest>,
) -> Result<Json<Vec<PullRequestInfo>>, ApiError> {
    let repo = PathBuf::from(request.repo.trim());
    ensure_git_repo(&repo)?;
    let pulls = gh_json::<Vec<PullRequestInfo>>(
        Some(&repo),
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,url,state,baseRefName,headRefName,isDraft,author,updatedAt",
        ],
    )
    .await?;
    Ok(Json(pulls))
}

async fn github_compare_pr(
    State(state): State<AppState>,
    Json(request): Json<GitHubCompareRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let repo = PathBuf::from(request.repo.trim());
    ensure_git_repo(&repo)?;
    let repository = github_repo_for_local(&repo).await?;
    start_github_pr_session(state, repo, repository, request.number).await
}

async fn github_open_url(
    State(state): State<AppState>,
    Json(request): Json<GitHubUrlRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let reference = parse_github_pr_url(request.url.trim())?;
    let selected_repo = PathBuf::from(request.repo.trim());
    let repo = if selected_repo.is_dir()
        && github_repo_for_local(&selected_repo)
            .await
            .map(|repo| repo.eq_ignore_ascii_case(&reference.repo))
            .unwrap_or(false)
    {
        selected_repo
    } else {
        cached_github_repo(&reference.repo).await?
    };
    start_github_pr_session(state, repo, reference.repo, reference.number).await
}

async fn start_github_pr_session(
    state: AppState,
    repo: PathBuf,
    github_repo: String,
    number: u64,
) -> Result<Json<StartResponse>, ApiError> {
    let number_string = number.to_string();
    let pull = gh_json::<PullRequestInfo>(
        Some(&repo),
        &[
            "pr",
            "view",
            &number_string,
            "--repo",
            &github_repo,
            "--json",
            "number,title,url,state,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,author,updatedAt",
        ],
    )
    .await?;
    fetch_github_pr(&repo, &pull).await?;
    let base = git_commit(&repo, &pull.base_ref_oid).await?;
    let head = git_commit(&repo, &format!("refs/local-diffe/pr/{}", pull.number)).await?;
    let merge_base = git_merge_base(&repo, &base, &head).await?;
    create_git_comparison(
        state,
        repo,
        merge_base,
        head,
        Some(pull),
        "PR comparison uses the fetched PR head and its Git merge-base; uncommitted working-tree changes are excluded.".into(),
    )
    .await
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

fn ensure_git_repo(repo: &PathBuf) -> Result<(), ApiError> {
    if !repo.is_dir() {
        return Err(ApiError::bad_request(format!(
            "Repository directory does not exist: {}",
            repo.display()
        )));
    }
    Ok(())
}

async fn gh_json<T: serde::de::DeserializeOwned>(
    repo: Option<&std::path::Path>,
    args: &[&str],
) -> Result<T, ApiError> {
    let bytes = gh_output(repo, args).await?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ApiError::internal(format!(
            "GitHub CLI returned invalid JSON: {error}. Run `gh auth status` to check its setup."
        ))
    })
}

async fn gh_output(
    repo: Option<&std::path::Path>,
    args: &[&str],
) -> Result<Vec<u8>, ApiError> {
    let mut command = Command::new("gh");
    command.args(args);
    if let Some(repo) = repo {
        command.current_dir(repo);
    }
    let output = command.output().await.map_err(|error| {
        ApiError::internal(format!(
            "Could not run the GitHub CLI (`gh`): {error}. Install it with `brew install gh`."
        ))
    })?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "GitHub CLI failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

async fn github_repo_for_local(repo: &PathBuf) -> Result<String, ApiError> {
    let info = gh_json::<GitHubRepoInfo>(Some(repo), &["repo", "view", "--json", "nameWithOwner"])
        .await?;
    Ok(info.name_with_owner)
}

fn parse_github_pr_url(url: &str) -> Result<GitHubPrReference, ApiError> {
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("github.com/"))
        .ok_or_else(|| {
            ApiError::bad_request(
                "Enter a GitHub pull-request URL such as https://github.com/owner/repo/pull/123.",
            )
        })?;
    let path = path.split(['?', '#']).next().unwrap_or(path).trim_end_matches('/');
    let pieces = path.split('/').collect::<Vec<_>>();
    let [owner, name, "pull", number] = pieces.as_slice() else {
        return Err(ApiError::bad_request(
            "Enter a GitHub pull-request URL such as https://github.com/owner/repo/pull/123.",
        ));
    };
    if !is_github_slug_part(owner) || !is_github_slug_part(name) {
        return Err(ApiError::bad_request("The GitHub owner or repository name is invalid."));
    }
    let number = number
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| ApiError::bad_request("The pull-request number must be a positive integer."))?;
    Ok(GitHubPrReference {
        repo: format!("{owner}/{name}"),
        number,
    })
}

fn is_github_slug_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

async fn cached_github_repo(github_repo: &str) -> Result<PathBuf, ApiError> {
    let mut pieces = github_repo.split('/');
    let (Some(owner), Some(name), None) = (pieces.next(), pieces.next(), pieces.next()) else {
        return Err(ApiError::bad_request("Invalid GitHub repository name."));
    };
    if !is_github_slug_part(owner) || !is_github_slug_part(name) {
        return Err(ApiError::bad_request("Invalid GitHub repository name."));
    }
    let directories = ProjectDirs::from("com", "hydradb", "local-diffe")
        .ok_or_else(|| ApiError::internal("Could not determine Local Diffe's cache directory."))?;
    let destination = directories
        .cache_dir()
        .join("github-repos")
        .join(format!("{owner}--{name}"));
    if destination.join(".git").is_dir() {
        return Ok(destination);
    }
    if destination.exists() {
        return Err(ApiError::bad_request(format!(
            "GitHub cache path already exists but is not a repository: {}",
            destination.display()
        )));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| ApiError::internal("Could not construct GitHub cache path."))?;
    fs::create_dir_all(parent)
        .map_err(|error| ApiError::internal(format!("Could not create GitHub cache directory: {error}")))?;
    let destination_string = destination.to_string_lossy().to_string();
    gh_output(None, &["repo", "clone", github_repo, &destination_string]).await?;
    if !destination.join(".git").is_dir() {
        return Err(ApiError::internal("GitHub CLI completed but did not create the expected repository."));
    }
    Ok(destination)
}

async fn fetch_github_pr(repo: &PathBuf, pull: &PullRequestInfo) -> Result<(), ApiError> {
    git_command(repo, &["fetch", "--prune", "origin"]).await?;
    git_command(repo, &["fetch", "origin", &pull.base_ref_name]).await?;
    let refspec = format!(
        "+refs/pull/{}/head:refs/local-diffe/pr/{}",
        pull.number, pull.number
    );
    git_command(repo, &["fetch", "origin", &refspec]).await
}

async fn git_command(repo: &PathBuf, args: &[&str]) -> Result<(), ApiError> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not run git: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Git command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

async fn git_merge_base(repo: &PathBuf, base: &str, target: &str) -> Result<String, ApiError> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(["merge-base", base, target])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not run git merge-base: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Could not find a merge-base for `{base}` and `{target}`: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    String::from_utf8(output.stdout)
        .map(|commit| commit.trim().to_owned())
        .map_err(|_| ApiError::internal("git merge-base returned non-UTF-8 output."))
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
    let template = asset_text(&SEMANTICDIFF_WEBVIEW, "index.html").ok_or_else(|| {
        ApiError::internal("Embedded SemanticDiff webview is missing index.html.")
    })?;
    let bridge = r#"<style>:root{color-scheme:dark;--vscode-font-family:ui-sans-serif,system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:ui-monospace,SFMono-Regular,Menlo,monospace;--vscode-editor-font-size:12px;--vscode-editor-background:#0d1117;--vscode-editor-foreground:#e6edf3;--vscode-breadcrumb-background:#161b22;--vscode-breadcrumb-foreground:#c9d1d9;--vscode-breadcrumb-focusForeground:#58a6ff;--vscode-editorWidget-border:#30363d;--vscode-scrollbar-shadow:#010409;--vscode-focusBorder:#58a6ff;--vscode-button-background:#238636;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#2ea043;--vscode-input-background:#0d1117;--vscode-input-foreground:#e6edf3;--vscode-list-activeSelectionBackground:#1f6feb;--vscode-list-hoverBackground:#21262d;--vscode-diffEditor-insertedLineBackground:#0c281a;--vscode-diffEditor-removedLineBackground:#2a171d;--vscode-diffEditor-insertedTextBackground:#10351f;--vscode-diffEditor-removedTextBackground:#43212a;--vscode-diffEditor-diagonalFill:#30363d;--vscode-minimapSlider-background:#8b949e99;--vscode-peekViewResult-background:#161b22;--vscode-editorOverviewRuler-modifiedForeground:#58a6ff;--vscode-editorOverviewRuler-deletedForeground:#f85149;--vscode-editorOverviewRuler-addedForeground:#3fb950;--vscode-editorLineNumber-foreground:#8b949e;--vscode-editorUnicodeHighlight-background:#6e40c933;--vscode-editorUnicodeHighlight-border:#6e40c9;--vscode-editor-selectionBackground:#264f78;--vscode-notifications-background:#161b22;--vscode-notifications-border:#30363d;--vscode-notifications-foreground:#c9d1d9;--vscode-notificationsErrorIcon-foreground:#f85149;--vscode-disabledForeground:#8b949e;--vscode-icon-foreground:#c9d1d9;--vscode-editorCodeLens-foreground:#8b949e;--vscode-editorGhostText-foreground:#8b949e;--vscode-editorHint-foreground:#8b949e;--vscode-editorInlayHint-background:#21262d;--vscode-editorLink-activeForeground:#58a6ff;--vscode-editorSuggestWidget-foreground:#c9d1d9;--vscode-editorSuggestWidget-selectedForeground:#fff;--vscode-editorWidget-background:#161b22;--vscode-menu-selectionBackground:#1f6feb;--vscode-menu-selectionForeground:#fff;--vscode-statusBar-background:#161b22;--vscode-statusBar-foreground:#c9d1d9;--vscode-statusBarItem-hoverBackground:#21262d;--vscode-statusBarItem-hoverForeground:#fff;--vscode-toolbar-activeBackground:#30363d;--vscode-toolbar-hoverBackground:#21262d;--vscode-tree-tableColumnsBorder:#30363d;--vscode-tree-tableOddRowsBackground:#161b22}html,body{background:#0d1117!important;color:#e6edf3!important}.patch,.patch .line,.patch .code-fg,.patch .line .content,.patch .header{color:#c9d1d9!important}.patch .line .line-number,.patch .line .number{color:#8b949e!important}.patch .code-bg.added+.code-fg span[style*="rgb(139, 148, 158)"],.patch .code-bg.removed+.code-fg span[style*="rgb(139, 148, 158)"]{color:#d0d7de!important}.patch .line.added,.patch .mark.added{color:#b7dfc2!important}.patch .line.removed,.patch .mark.removed{color:#f0c8cf!important}</style><script>window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:(message)=>window.parent!==window&&window.parent.postMessage({source:'semanticdiff',message},'*')});</script><script src="script.js"></script>"#;
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
