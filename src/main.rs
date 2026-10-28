use std::{
    collections::{HashMap, HashSet},
    fs,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
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
use serde_json::json;
use tokio::{process::Command, sync::Mutex as AsyncMutex};
use uuid::Uuid;

mod adapters;
mod application;
mod commits;
mod domain;
mod http;
mod ports;
mod review;
mod stack_history;
mod stacks;
mod storage;
mod symbols;
#[cfg(test)]
mod test_support;
mod warmup;
use commits::{CommitInfo, CommitLog, ScopeMode};
use domain::{FileEntry, SemanticResponse};
use stacks::{Stack, StackMember, StackMode};

static WEB_ASSETS: Dir<'_> = include_dir!("$OUT_DIR/embedded/web");
static SEMANTICDIFF_WEBVIEW: Dir<'_> = include_dir!("$OUT_DIR/embedded/semanticdiff-webview");
static SEMANTICDIFF_RUNTIME: Dir<'_> = include_dir!("$OUT_DIR/embedded/semanticdiff-runtime");

// `gh` is already required for GitHub PR metadata. Reuse its active token for
// the cache clone rather than relying on this machine's SSH key configuration.
const GITHUB_GIT_CREDENTIAL_HELPER: &str = "credential.helper=!gh auth git-credential";

// Branch names link stacked PRs; OIDs and the fork flag keep stacks honest.
const OPEN_PR_FIELDS: &str = "number,title,url,state,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,isCrossRepository,author,updatedAt";

#[derive(Parser, Debug)]
#[command(
    version = env!("LOCAL_DIFFE_VERSION"),
    about = "A self-contained local viewer for Git patches using SemanticDiff"
)]
struct Args {
    /// Address to listen on.
    #[arg(long)]
    listen: Option<SocketAddr>,

    /// Port to listen on when --listen is not supplied.
    #[arg(long, env = "LOCAL_DIFFE_PORT", default_value_t = 3333)]
    port: u16,

    /// Directory for SemanticDiff, GitHub repository, and pull-request caches.
    #[arg(long, env = "LOCAL_DIFFE_CACHE_DIR", value_name = "DIR")]
    cache_dir: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    diffs: Arc<dyn ports::DiffReader>,
    cache_dir: PathBuf,
    // Git updates use lock files inside a repository. Keep cache population and
    // foreground PR opens from trying to update the same cached clone at once.
    github_cache_lock: Arc<AsyncMutex<()>>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    warmup: warmup::Warmup,
    reviews: Arc<Mutex<review::Snapshots>>,
}

#[derive(Clone)]
struct Session {
    repo: PathBuf,
    repository: String,
    base: String,
    target: String,
    files: Vec<FileEntry>,
    /// First-parent commits of a full comparison; empty for commit scopes.
    commits: Vec<CommitInfo>,
    /// The PR stack this comparison belongs to, shared by its members' sessions.
    stack: Option<Arc<Stack>>,
}

#[derive(Serialize)]
struct RevisionInfo {
    revision: String,
    commit: String,
}

#[derive(Serialize)]
struct ComparisonInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
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
struct CommitScopeRequest {
    /// The full comparison's session, which owns the commit list.
    id: String,
    sha: String,
    mode: ScopeMode,
}

#[derive(Deserialize)]
struct StackScopeRequest {
    /// Any session of the stack; the stack it owns lists the allowed PRs.
    id: String,
    number: u64,
    mode: StackMode,
}

#[derive(Deserialize)]
struct GitHubPullsRequest {
    repo: String,
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
struct GitHubCompareRequest {
    repo: String,
    number: u64,
}

#[derive(Deserialize)]
struct GitHubUrlRequest {
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
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(rename = "isCrossRepository", default)]
    is_cross_repository: bool,
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
    repository: String,
    files: Vec<FileEntry>,
    comparison: Option<ComparisonInfo>,
    commits: Vec<CommitInfo>,
    commits_truncated: bool,
    stack: Option<StackView>,
}

#[derive(Serialize)]
struct StackView {
    trunk: String,
    current: u64,
    mode: StackMode,
    members: Vec<StackMember>,
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
    dotenvy::dotenv().ok();
    let args = Args::parse();
    let listen = args
        .listen
        .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], args.port)));
    let cache_dir = args.cache_dir.unwrap_or_else(default_cache_dir);
    let semanticdiff_bin = extract_semanticdiff(&cache_dir).unwrap_or_else(|error| {
        eprintln!("Could not prepare embedded SemanticDiff: {error}");
        std::process::exit(2);
    });

    let state = AppState {
        diffs: Arc::new(application::DiffService::new(
            Arc::new(adapters::GitDiffSource),
            Arc::new(adapters::SemanticCli::new(semanticdiff_bin)),
            Arc::new(storage::FoyerDiffStore::new(500 * 1024 * 1024)),
        )),
        cache_dir,
        github_cache_lock: Arc::new(AsyncMutex::new(())),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        warmup: warmup::Warmup::default(),
        reviews: Arc::new(Mutex::new(review::Snapshots::default())),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/assets/{*path}", get(web_asset))
        .route("/api/patch", post(start_session))
        .route("/api/git-diff", post(start_git_diff))
        .route("/api/github/open-prs", post(github_open_prs))
        .route("/api/github/compare", post(github_compare_pr))
        .route("/api/github/open-url", post(github_open_url))
        .route("/api/commit-scope", post(commit_scope))
        .route("/api/stack-scope", post(stack_scope))
        .route("/api/stack-history", post(stack_history::history))
        .route("/api/review-snapshot", post(review::snapshot))
        .route("/api/since-review", post(review::since_review))
        .route("/api/stack-symbols", post(symbols::stack_symbols))
        .route("/api/semantic/{id}/{index}", post(semantic_file))
        .route("/api/diff/{id}/{index}", get(http::text_diff))
        .route("/semanticdiff-view/{id}/{index}", get(semanticdiff_view))
        .route("/semanticdiff-assets/{*path}", get(semanticdiff_asset))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(listen).await.unwrap();
    println!("Local Diffe listening at http://{}", listen);
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

fn default_cache_dir() -> PathBuf {
    ProjectDirs::from("com", "hydradb", "local-diffe")
        .map(|directories| directories.cache_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".local-diffe-cache"))
}

fn extract_semanticdiff(cache_dir: &FsPath) -> Result<PathBuf, String> {
    let runtime = cache_dir
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
    fn extract(source: &Dir<'_>, destination: &FsPath) -> Result<(), String> {
        for file in source.files() {
            let target = destination.join(file.path());
            fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
            let bytes =
                zstd::stream::decode_all(file.contents()).map_err(|error| error.to_string())?;
            fs::write(target, bytes).map_err(|error| error.to_string())?;
        }
        for directory in source.dirs() {
            extract(directory, destination)?;
        }
        Ok(())
    }
    extract(source, destination)
        .map_err(|error| format!("could not extract embedded SemanticDiff files: {error}"))?;
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
    let (base, target) = tokio::try_join!(
        git_commit(&repo, &request.base),
        git_commit(&repo, &request.target),
    )?;
    let files = parse_patch(&request.patch);
    require_files(&files)?;
    Ok(create_session(
        state,
        repo,
        base,
        target,
        files,
        None,
        CommitLog::default(),
        None,
    ))
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
        None,
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
    stack: Option<StackSelection>,
) -> Result<Json<StartResponse>, ApiError> {
    let (base_commit, target_commit) =
        tokio::try_join!(git_commit(&repo, &base), git_commit(&repo, &target),)?;
    let (files, log) = if let Some(selection) = &stack {
        let prepared = selection
            .stack
            .comparison(&repo, selection.number, selection.mode)
            .await?;
        (prepared.files.clone(), prepared.log.clone())
    } else {
        tokio::try_join!(
            comparison_files(&repo, &base_commit, &target_commit),
            commits::commit_log(&repo, &base_commit, &target_commit),
        )?
    };
    // A stack member may legitimately add nothing on top of its parent; the
    // review still opens so the rest of the stack stays reachable.
    if stack.is_none() {
        require_files(&files)?;
    }
    let comparison = comparison_info(
        RevisionInfo {
            revision: base,
            commit: base_commit.clone(),
        },
        RevisionInfo {
            revision: target,
            commit: target_commit.clone(),
        },
        &files,
        description,
        pull_request,
    );
    Ok(create_session(
        state,
        repo,
        base_commit,
        target_commit,
        files,
        Some(comparison),
        log,
        stack,
    ))
}

/// Scope a full comparison to one of its commits. The commit must come from
/// that comparison's own list, so no client-supplied revision reaches Git.
async fn commit_scope(
    State(state): State<AppState>,
    Json(request): Json<CommitScopeRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let (repo, repository, range_base, commit, position, total) = {
        let sessions = state.sessions.lock().unwrap();
        let session = sessions.get(&request.id).ok_or_else(|| {
            ApiError::bad_request("This session has expired. Reload the comparison.")
        })?;
        let position = session
            .commits
            .iter()
            .position(|commit| commit.sha == request.sha)
            .ok_or_else(|| ApiError::bad_request("That commit is not part of this comparison."))?;
        (
            session.repo.clone(),
            session.repository.clone(),
            session.base.clone(),
            session.commits[position].clone(),
            position + 1,
            session.commits.len(),
        )
    };
    let base_commit = commits::scope_base(&repo, &commit, request.mode, &range_base).await?;
    let files = comparison_files(&repo, &base_commit, &commit.sha).await?;
    let (base_revision, description) = match request.mode {
        ScopeMode::Commit if commit.parents.is_empty() => (
            "empty tree".to_owned(),
            format!("Commit {position} of {total}: a root commit, compared with the empty tree."),
        ),
        ScopeMode::Commit if commit.parents.len() > 1 => (
            format!("{}^", commit.short),
            format!("Commit {position} of {total}: a merge, compared with its first parent."),
        ),
        ScopeMode::Commit => (
            format!("{}^", commit.short),
            format!("Commit {position} of {total}, compared with its parent."),
        ),
        ScopeMode::Cumulative => (
            "base".to_owned(),
            format!(
                "Commits 1–{position} of {total}: the comparison base through {}.",
                commit.short
            ),
        ),
    };
    let comparison = comparison_info(
        RevisionInfo {
            revision: base_revision,
            commit: base_commit.clone(),
        },
        RevisionInfo {
            revision: commit.short.clone(),
            commit: commit.sha.clone(),
        },
        &files,
        description,
        None,
    );
    let target = commit.sha.clone();
    let Json(mut response) = create_session(
        state.clone(),
        repo,
        base_commit,
        target,
        files,
        Some(comparison),
        CommitLog::default(),
        None,
    );
    // Commit scopes retain the full review's repository identity even though
    // their comparison deliberately has no PR/stack selection.
    response.repository = repository.clone();
    state
        .sessions
        .lock()
        .unwrap()
        .get_mut(&response.id)
        .unwrap()
        .repository = repository;
    Ok(Json(response))
}

async fn comparison_files(
    repo: &PathBuf,
    base: &str,
    target: &str,
) -> Result<Vec<FileEntry>, ApiError> {
    let (mut files, renderable_paths) = tokio::try_join!(
        git_changed_files(repo, base, target),
        git_renderable_paths(repo, base, target),
    )?;
    for file in &mut files {
        file.renderable = renderable_paths.contains(&file.display_path);
    }
    Ok(files)
}

fn comparison_info(
    base: RevisionInfo,
    target: RevisionInfo,
    files: &[FileEntry],
    description: String,
    pull_request: Option<PullRequestInfo>,
) -> ComparisonInfo {
    ComparisonInfo {
        kind: None,
        base,
        target,
        changed_paths: files.len(),
        semantic_paths: files.iter().filter(|file| file.renderable).count(),
        description,
        pull_request,
    }
}

async fn github_open_prs(
    State(state): State<AppState>,
    Json(request): Json<GitHubPullsRequest>,
) -> Result<Json<Vec<PullRequestInfo>>, ApiError> {
    let repo = PathBuf::from(request.repo.trim());
    ensure_git_repo(&repo)?;
    let github_repo = github_repo_for_local(&repo).await?;
    let pulls = match (!request.refresh)
        .then(|| read_pr_list_cache(&state.cache_dir, &github_repo))
        .flatten()
    {
        Some(pulls) => pulls,
        None => {
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
                    OPEN_PR_FIELDS,
                ],
            )
            .await?;
            write_pr_list_cache(&state.cache_dir, &github_repo, &pulls)?;
            pulls
        }
    };
    warm_github_pr_cache(state.clone(), github_repo, pulls.clone(), request.refresh);
    Ok(Json(pulls))
}

async fn github_compare_pr(
    State(state): State<AppState>,
    Json(request): Json<GitHubCompareRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let repo = PathBuf::from(request.repo.trim());
    ensure_git_repo(&repo)?;
    let repository = github_repo_for_local(&repo).await?;
    let _cache_lock = state.github_cache_lock.clone().lock_owned().await;
    let cached_repo = cached_github_repo(&state.cache_dir, &repository).await?;
    start_github_pr_session(state, cached_repo, repository, request.number).await
}

async fn github_open_url(
    State(state): State<AppState>,
    Json(request): Json<GitHubUrlRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let reference = parse_github_pr_url(request.url.trim())?;
    // A pasted PR URL is intentionally independent from the folder selected in
    // the UI. Reviews always run against the application's cached clone.
    let _cache_lock = state.github_cache_lock.clone().lock_owned().await;
    let repo = cached_github_repo(&state.cache_dir, &reference.repo).await?;
    start_github_pr_session(state, repo, reference.repo, reference.number).await
}

fn warm_github_pr_cache(
    state: AppState,
    github_repo: String,
    pulls: Vec<PullRequestInfo>,
    refresh: bool,
) {
    tokio::spawn(async move {
        let _cache_lock = state.github_cache_lock.lock().await;
        let repo = match cached_github_repo(&state.cache_dir, &github_repo).await {
            Ok(repo) => repo,
            Err(error) => {
                eprintln!(
                    "Could not warm GitHub PR cache for {github_repo}: {}",
                    error.message
                );
                return;
            }
        };
        if let Err(error) = fetch_github_pr_heads(&repo, &pulls).await {
            eprintln!(
                "Could not warm GitHub PR heads for {github_repo}: {}",
                error.message
            );
            return;
        }
        for listed_pull in pulls {
            let result = async {
                let pull = github_pr_info(
                    &state.cache_dir,
                    &repo,
                    &github_repo,
                    listed_pull.number,
                    refresh,
                )
                .await?;
                fetch_github_pr(&repo, &pull, refresh).await
            }
            .await;
            if let Err(error) = result {
                eprintln!(
                    "Could not warm PR #{} for {github_repo}: {}",
                    listed_pull.number, error.message
                );
            }
        }
    });
}

async fn github_pr_info(
    cache_dir: &FsPath,
    repo: &FsPath,
    github_repo: &str,
    number: u64,
    refresh: bool,
) -> Result<PullRequestInfo, ApiError> {
    if !refresh {
        if let Some(pull) = read_pr_cache(cache_dir, github_repo, number) {
            return Ok(pull);
        }
    }
    let number_string = number.to_string();
    let pull = gh_json::<PullRequestInfo>(
        Some(repo),
        &[
            "pr",
            "view",
            &number_string,
            "--repo",
            github_repo,
            "--json",
            "number,title,url,state,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,isCrossRepository,author,updatedAt",
        ],
    )
    .await?;
    write_pr_cache(cache_dir, github_repo, &pull)?;
    Ok(pull)
}

async fn start_github_pr_session(
    state: AppState,
    repo: PathBuf,
    github_repo: String,
    number: u64,
) -> Result<Json<StartResponse>, ApiError> {
    let (pull, open) = tokio::join!(
        github_pr_info(&state.cache_dir, &repo, &github_repo, number, false),
        open_pulls(&state.cache_dir, &repo, &github_repo),
    );
    let pull = pull?;
    let members = stacks::stack_members(&open, &pull);
    if !members.is_empty() {
        let stack = Arc::new(stacks::resolve(&repo, members).await?);
        for member in &stack.members {
            write_pr_cache(&state.cache_dir, &github_repo, &member.member.pull)?;
        }
        return open_stack_member(state, repo, stack, number, StackMode::Pr).await;
    }
    fetch_github_pr(&repo, &pull, false).await?;
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
        None,
    )
    .await
}

/// Open another PR of a session's stack. Like commit scopes, the PR must come
/// from the stack the session owns, so no client-supplied revision reaches Git.
async fn stack_scope(
    State(state): State<AppState>,
    Json(request): Json<StackScopeRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let (repo, stack) = {
        let sessions = state.sessions.lock().unwrap();
        let session = sessions.get(&request.id).ok_or_else(|| {
            ApiError::bad_request("This session has expired. Reload the comparison.")
        })?;
        let stack = session
            .stack
            .clone()
            .ok_or_else(|| ApiError::bad_request("This comparison is not part of a PR stack."))?;
        (session.repo.clone(), stack)
    };
    open_stack_member(state, repo, stack, request.number, request.mode).await
}

struct StackSelection {
    stack: Arc<Stack>,
    number: u64,
    mode: StackMode,
}

async fn open_stack_member(
    state: AppState,
    repo: PathBuf,
    stack: Arc<Stack>,
    number: u64,
    mode: StackMode,
) -> Result<Json<StartResponse>, ApiError> {
    let position = stack
        .position(number)
        .ok_or_else(|| ApiError::bad_request("That pull request is not part of this stack."))?;
    let member = &stack.members[position];
    let total = stack.members.len();
    let ordinal = position + 1;
    let parent = member.member.parent;
    let (base, description) = match (mode, parent) {
        (StackMode::Pr, Some(parent)) => (
            member.base.clone(),
            format!("Stacked PR {ordinal} of {total}: compared with PR #{parent}'s current head, so only this PR's own changes are shown."),
        ),
        (StackMode::Pr, None) => (
            member.base.clone(),
            format!("Stacked PR {ordinal} of {total}: the bottom of the stack, compared with its merge-base on `{}`.", stack.trunk),
        ),
        (StackMode::Cumulative, _) => (
            member.cumulative_base.clone(),
            format!("Stack through PR #{number}: everything from `{}` up to and including this PR.", stack.trunk),
        ),
    };
    let base_label = match (mode, parent) {
        (StackMode::Pr, Some(parent)) => format!("#{parent}"),
        _ => stack.trunk.clone(),
    };
    let head = member.head.clone();
    let pull = member.member.pull.clone();
    let response = create_git_comparison(
        state,
        repo,
        base,
        head,
        Some(pull),
        description,
        Some(StackSelection {
            stack: stack.clone(),
            number,
            mode,
        }),
    )
    .await?;
    // Commits read better against a PR or branch name than a bare SHA.
    let Json(mut response) = response;
    if let Some(comparison) = response.comparison.as_mut() {
        comparison.base.revision = base_label;
        comparison.target.revision = format!("#{number}");
    }
    Ok(Json(response))
}

/// The open PRs used to find a stack. The cached list is reused (the PR list's
/// Refresh rewrites it); a failure only means the PR opens without its stack.
async fn open_pulls(cache_dir: &FsPath, repo: &FsPath, github_repo: &str) -> Vec<PullRequestInfo> {
    if let Some(pulls) = read_pr_list_cache(cache_dir, github_repo) {
        return pulls;
    }
    match gh_json::<Vec<PullRequestInfo>>(
        Some(repo),
        &[
            "pr",
            "list",
            "--repo",
            github_repo,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            OPEN_PR_FIELDS,
        ],
    )
    .await
    {
        Ok(pulls) => {
            if let Err(error) = write_pr_list_cache(cache_dir, github_repo, &pulls) {
                eprintln!(
                    "Could not cache open PRs for {github_repo}: {}",
                    error.message
                );
            }
            pulls
        }
        Err(error) => {
            eprintln!(
                "Could not list open PRs for {github_repo}; opening without its stack: {}",
                error.message
            );
            Vec::new()
        }
    }
}

/// A full comparison with nothing to show is an error; a single commit may
/// legitimately change no files.
fn require_files(files: &[FileEntry]) -> Result<(), ApiError> {
    if files.is_empty() {
        return Err(ApiError::bad_request(
            "No text file changes were found between these revisions.",
        ));
    }
    Ok(())
}

fn create_session(
    state: AppState,
    repo: PathBuf,
    base: String,
    target: String,
    files: Vec<FileEntry>,
    comparison: Option<ComparisonInfo>,
    log: CommitLog,
    stack: Option<StackSelection>,
) -> Json<StartResponse> {
    let id = Uuid::new_v4().to_string();
    let repository = review::repository_identity(&repo, comparison.as_ref(), stack.as_ref());
    let session = Session {
        repo,
        repository: repository.clone(),
        base: base.trim().to_owned(),
        target: target.trim().to_owned(),
        files: files.clone(),
        commits: log.commits.clone(),
        stack: stack.as_ref().map(|selection| selection.stack.clone()),
    };
    state.warmup.start(state.diffs.clone(), session.clone());
    state.sessions.lock().unwrap().insert(id.clone(), session);
    Json(StartResponse {
        id,
        repository,
        files,
        comparison,
        commits: log.commits,
        commits_truncated: log.truncated,
        stack: stack.map(|selection| StackView {
            trunk: selection.stack.trunk.clone(),
            current: selection.number,
            mode: selection.mode,
            members: selection
                .stack
                .members
                .iter()
                .map(|member| member.member.clone())
                .collect(),
        }),
    })
}

fn validate_git_input(repo: &FsPath, base: &str, target: &str) -> Result<(), ApiError> {
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

fn ensure_git_repo(repo: &FsPath) -> Result<(), ApiError> {
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

async fn gh_output(repo: Option<&std::path::Path>, args: &[&str]) -> Result<Vec<u8>, ApiError> {
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

async fn github_repo_for_local(repo: &FsPath) -> Result<String, ApiError> {
    let info =
        gh_json::<GitHubRepoInfo>(Some(repo), &["repo", "view", "--json", "nameWithOwner"]).await?;
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
    let path = path
        .split(['?', '#'])
        .next()
        .unwrap_or(path)
        .trim_end_matches('/');
    let pieces = path.split('/').collect::<Vec<_>>();
    let [owner, name, "pull", number] = pieces.as_slice() else {
        return Err(ApiError::bad_request(
            "Enter a GitHub pull-request URL such as https://github.com/owner/repo/pull/123.",
        ));
    };
    if !is_github_slug_part(owner) || !is_github_slug_part(name) {
        return Err(ApiError::bad_request(
            "The GitHub owner or repository name is invalid.",
        ));
    }
    let number = number
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| {
            ApiError::bad_request("The pull-request number must be a positive integer.")
        })?;
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

async fn cached_github_repo(cache_dir: &FsPath, github_repo: &str) -> Result<PathBuf, ApiError> {
    let mut pieces = github_repo.split('/');
    let (Some(owner), Some(name), None) = (pieces.next(), pieces.next(), pieces.next()) else {
        return Err(ApiError::bad_request("Invalid GitHub repository name."));
    };
    if !is_github_slug_part(owner) || !is_github_slug_part(name) {
        return Err(ApiError::bad_request("Invalid GitHub repository name."));
    }
    let destination = cache_dir
        .join("github-repos")
        .join(format!("{owner}--{name}"));
    let remote_url = format!("https://github.com/{github_repo}.git");
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
    fs::create_dir_all(parent).map_err(|error| {
        ApiError::internal(format!("Could not create GitHub cache directory: {error}"))
    })?;
    let destination_string = destination.to_string_lossy().to_string();
    let output = Command::new("git")
        .args(["-c", GITHUB_GIT_CREDENTIAL_HELPER])
        .args([
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            &remote_url,
            &destination_string,
        ])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not run git: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Could not clone the GitHub cache repository: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    if !destination.join(".git").is_dir() {
        return Err(ApiError::internal(
            "GitHub CLI completed but did not create the expected repository.",
        ));
    }
    Ok(destination)
}

fn github_pr_cache_dir(cache_dir: &FsPath, github_repo: &str) -> Result<PathBuf, ApiError> {
    let mut pieces = github_repo.split('/');
    let (Some(owner), Some(name), None) = (pieces.next(), pieces.next(), pieces.next()) else {
        return Err(ApiError::bad_request("Invalid GitHub repository name."));
    };
    if !is_github_slug_part(owner) || !is_github_slug_part(name) {
        return Err(ApiError::bad_request("Invalid GitHub repository name."));
    }
    Ok(cache_dir
        .join("github-prs")
        .join(format!("{owner}--{name}")))
}

fn read_pr_list_cache(cache_dir: &FsPath, github_repo: &str) -> Option<Vec<PullRequestInfo>> {
    read_json_cache(
        &github_pr_cache_dir(cache_dir, github_repo)
            .ok()?
            .join("open.json"),
    )
}

fn write_pr_list_cache(
    cache_dir: &FsPath,
    github_repo: &str,
    pulls: &[PullRequestInfo],
) -> Result<(), ApiError> {
    write_json_cache(
        &github_pr_cache_dir(cache_dir, github_repo)?.join("open.json"),
        pulls,
    )
}

fn read_pr_cache(cache_dir: &FsPath, github_repo: &str, number: u64) -> Option<PullRequestInfo> {
    read_json_cache(
        &github_pr_cache_dir(cache_dir, github_repo)
            .ok()?
            .join(format!("{number}.json")),
    )
}

fn write_pr_cache(
    cache_dir: &FsPath,
    github_repo: &str,
    pull: &PullRequestInfo,
) -> Result<(), ApiError> {
    write_json_cache(
        &github_pr_cache_dir(cache_dir, github_repo)?.join(format!("{}.json", pull.number)),
        pull,
    )
}

fn read_json_cache<T: serde::de::DeserializeOwned>(path: &FsPath) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_json_cache<T: Serialize + ?Sized>(path: &FsPath, value: &T) -> Result<(), ApiError> {
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("Could not construct cache path."))?;
    fs::create_dir_all(parent).map_err(|error| {
        ApiError::internal(format!("Could not create cache directory: {error}"))
    })?;
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|error| ApiError::internal(format!("Could not serialize cache entry: {error}")))?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, contents)
        .map_err(|error| ApiError::internal(format!("Could not write cache entry: {error}")))?;
    fs::rename(&temporary, path)
        .map_err(|error| ApiError::internal(format!("Could not finalize cache entry: {error}")))
}

async fn fetch_github_pr(
    repo: &PathBuf,
    pull: &PullRequestInfo,
    refresh: bool,
) -> Result<(), ApiError> {
    if refresh || !git_commit_exists(repo, &pull.base_ref_oid).await {
        git_command(repo, &["fetch", "origin", &pull.base_ref_name]).await?;
    }
    let refspec = format!(
        "+refs/pull/{}/head:refs/local-diffe/pr/{}",
        pull.number, pull.number
    );
    let pr_ref = format!("refs/local-diffe/pr/{}", pull.number);
    if refresh || !git_commit_exists(repo, &pr_ref).await {
        git_command(repo, &["fetch", "origin", &refspec]).await?;
    }
    Ok(())
}

async fn fetch_github_pr_heads(repo: &PathBuf, pulls: &[PullRequestInfo]) -> Result<(), ApiError> {
    let mut args = vec!["fetch".to_owned(), "origin".to_owned()];
    args.extend(pulls.iter().map(|pull| {
        format!(
            "+refs/pull/{}/head:refs/local-diffe/pr/{}",
            pull.number, pull.number
        )
    }));
    if args.len() > 2 {
        let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        git_command(repo, &arg_refs).await?;
    }
    Ok(())
}

async fn git_commit_exists(repo: &PathBuf, revision: &str) -> bool {
    let expression = format!("{revision}^{{commit}}");
    Command::new("git")
        .current_dir(repo)
        .args(["rev-parse", "--verify", "--quiet", &expression])
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn git_command(repo: &PathBuf, args: &[&str]) -> Result<(), ApiError> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(["-c", GITHUB_GIT_CREDENTIAL_HELPER])
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

/// Read changed paths from Git's NUL-delimited machine format.  Patch headers are
/// intentionally not used here: an added empty file has no `---`/`+++` hunk even
/// though it is a real changed path.
async fn git_changed_files(
    repo: &PathBuf,
    base: &str,
    target: &str,
) -> Result<Vec<FileEntry>, ApiError> {
    let mut command = Command::new("git");
    command.current_dir(repo).args([
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--name-status",
        "-z",
        base,
        target,
    ]);
    let output = adapters::output(command, "Git", None, 16 * 1024 * 1024).await?;
    let fields = output.split(|byte| *byte == b'\0').collect::<Vec<_>>();
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
            change_kind: Some(
                match status.as_bytes()[0] {
                    b'A' => "added",
                    b'D' => "deleted",
                    b'R' => "renamed",
                    b'C' => "copied",
                    b'M' => "modified",
                    b'T' => "type-changed",
                    _ => "unknown",
                }
                .into(),
            ),
            renderable: false,
        });
    }
    Ok(files)
}

/// Return paths with textual content changes without materializing the full
/// patch. This keeps large pull requests responsive and excludes binary or
/// metadata-only changes from the semantic viewer.
async fn git_renderable_paths(
    repo: &PathBuf,
    base: &str,
    target: &str,
) -> Result<HashSet<String>, ApiError> {
    let mut command = Command::new("git");
    command.current_dir(repo).args([
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--numstat",
        "-z",
        base,
        target,
    ]);
    let output = adapters::output(command, "Git", None, 16 * 1024 * 1024).await?;
    parse_numstat(&output)
}

fn parse_numstat(output: &[u8]) -> Result<HashSet<String>, ApiError> {
    let mut renderable = HashSet::new();
    let fields = output.split(|byte| *byte == b'\0').collect::<Vec<_>>();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let record = std::str::from_utf8(record)
            .map_err(|_| ApiError::internal("Git returned a non-UTF-8 content summary."))?;
        let mut columns = record.splitn(3, '\t');
        let additions = columns.next().unwrap_or_default();
        let deletions = columns
            .next()
            .ok_or_else(|| ApiError::internal("Git returned an incomplete content summary."))?;
        let mut path = columns
            .next()
            .ok_or_else(|| ApiError::internal("Git returned an incomplete content summary."))?;
        // With -z, rename/copy records are numstat + empty path, followed by
        // the old and new paths as separate NUL fields. Neither is a stat row.
        if path.is_empty() {
            let old = fields
                .get(index)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::internal("Git returned an incomplete rename summary."))?;
            std::str::from_utf8(old)
                .map_err(|_| ApiError::internal("Git returned a non-UTF-8 old path."))?;
            path = std::str::from_utf8(
                fields
                    .get(index + 1)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ApiError::internal("Git returned an incomplete rename summary.")
                    })?,
            )
            .map_err(|_| ApiError::internal("Git returned a non-UTF-8 new path."))?;
            index += 2;
        }
        if additions != "-" && deletions != "-" && (additions != "0" || deletions != "0") {
            renderable.insert(path.to_owned());
        }
    }
    Ok(renderable)
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
    Ok(Json(http::semantic_response(&state, &id, index).await?))
}

async fn semanticdiff_view(
    State(state): State<AppState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Html<String>, ApiError> {
    let result = http::semantic_response(&state, &id, index).await?;
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
    let highlight_input = serde_json::to_string(&json!({
        "old": result.old_content,
        "new": result.new_content,
        "oldPath": result.file.old_path.as_deref().unwrap_or(""),
        "newPath": result.file.new_path.as_deref().unwrap_or("")
    }))
    .unwrap()
    .replace('<', "\\u003c")
    .replace('>', "\\u003e")
    .replace('&', "\\u0026");
    let highlighting_bridge = format!(
        "<script>window.initialHighlightInput={highlight_input};</script><script type=\"module\" src=\"/assets/semantic-viewer.js\"></script>"
    );
    let template = asset_text(&SEMANTICDIFF_WEBVIEW, "index.html").ok_or_else(|| {
        ApiError::internal("Embedded SemanticDiff webview is missing index.html.")
    })?;
    let bridge = r#"<style>:root{color-scheme:dark;--vscode-font-family:ui-sans-serif,system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:ui-monospace,SFMono-Regular,Menlo,monospace;--vscode-editor-font-size:12px;--vscode-editor-background:#0d1117;--vscode-editor-foreground:#e6edf3;--vscode-breadcrumb-background:#161b22;--vscode-breadcrumb-foreground:#c9d1d9;--vscode-breadcrumb-focusForeground:#58a6ff;--vscode-editorWidget-border:#30363d;--vscode-scrollbar-shadow:#010409;--vscode-focusBorder:#58a6ff;--vscode-button-background:#238636;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#2ea043;--vscode-input-background:#0d1117;--vscode-input-foreground:#e6edf3;--vscode-list-activeSelectionBackground:#1f6feb;--vscode-list-hoverBackground:#21262d;--vscode-diffEditor-insertedLineBackground:#0c281a;--vscode-diffEditor-removedLineBackground:#2a171d;--vscode-diffEditor-insertedTextBackground:#10351f;--vscode-diffEditor-removedTextBackground:#43212a;--vscode-diffEditor-diagonalFill:#30363d;--vscode-minimapSlider-background:#8b949e99;--vscode-peekViewResult-background:#161b22;--vscode-editorOverviewRuler-modifiedForeground:#58a6ff;--vscode-editorOverviewRuler-deletedForeground:#f85149;--vscode-editorOverviewRuler-addedForeground:#3fb950;--vscode-editorLineNumber-foreground:#8b949e;--vscode-editorUnicodeHighlight-background:#6e40c933;--vscode-editorUnicodeHighlight-border:#6e40c9;--vscode-editor-selectionBackground:#264f78;--vscode-notifications-background:#161b22;--vscode-notifications-border:#30363d;--vscode-notifications-foreground:#c9d1d9;--vscode-notificationsErrorIcon-foreground:#f85149;--vscode-disabledForeground:#8b949e;--vscode-icon-foreground:#c9d1d9;--vscode-editorCodeLens-foreground:#8b949e;--vscode-editorGhostText-foreground:#8b949e;--vscode-editorHint-foreground:#8b949e;--vscode-editorInlayHint-background:#21262d;--vscode-editorLink-activeForeground:#58a6ff;--vscode-editorSuggestWidget-foreground:#c9d1d9;--vscode-editorSuggestWidget-selectedForeground:#fff;--vscode-editorWidget-background:#161b22;--vscode-menu-selectionBackground:#1f6feb;--vscode-menu-selectionForeground:#fff;--vscode-statusBar-background:#161b22;--vscode-statusBar-foreground:#c9d1d9;--vscode-statusBarItem-hoverBackground:#21262d;--vscode-statusBarItem-hoverForeground:#fff;--vscode-toolbar-activeBackground:#30363d;--vscode-toolbar-hoverBackground:#21262d;--vscode-tree-tableColumnsBorder:#30363d;--vscode-tree-tableOddRowsBackground:#161b22}html,body{background:#0d1117!important;color:#e6edf3!important}.patch,.patch .line,.patch .code-fg,.patch .line .content,.patch .header{color:#c9d1d9!important}.patch .line .line-number,.patch .line .number{color:#8b949e!important}.patch .code-bg.added+.code-fg span[style*="rgb(139, 148, 158)"],.patch .code-bg.removed+.code-fg span[style*="rgb(139, 148, 158)"]{color:#d0d7de!important}.patch .line.added,.patch .mark.added{color:#b7dfc2!important}.patch .line.removed,.patch .mark.removed{color:#f0c8cf!important}</style><script>window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:(message)=>window.parent!==window&&window.parent.postMessage({source:'semanticdiff',message},'*')});</script><script src="script.js"></script>"#;
    // The renderer lives in an iframe, so relay the outer app's keyboard-overlay
    // keys to its parent. Local Diffe decides whether a relayed key is active.
    let keyboard_bridge = r#"<script>window.addEventListener('keydown',(event)=>{if(['-','?','Escape','f','d','v','j','k','F','D','V','J','K','[',']','{','}','n','m','N','M'].includes(event.key)){window.parent.postMessage({source:'local-diffe-keyboard',key:event.key},'*')}});</script>"#;
    let readiness_bridge = format!("<script>{}</script>", include_str!("semantic-bridge.js"));
    let html = template
        .replace("${webview.cspSource}", "'self'")
        .replace(
            "default-src 'self';",
            "default-src 'self'; worker-src 'self' blob:;",
        )
        .replace("${baseURL}", "/semanticdiff-assets")
        .replace("${ initialState }", &state_json)
        .replace(
            "<script src=\"script.js\"></script>",
            &format!("{readiness_bridge}{bridge}{keyboard_bridge}{highlighting_bridge}"),
        );
    Ok(Html(html))
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
                change_kind: None,
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

#[cfg(test)]
mod metadata_tests {
    use super::*;

    #[test]
    fn numstat_rename_fields_are_not_treated_as_rows() {
        let summary = b"1\t2\t\0old name.go\0new\tname.go\0-\t-\tbinary.bin\0\
            0\t0\t\0old-empty\0new-empty\0\
            1\t0\tliteral\tname.go\0";
        let paths = parse_numstat(summary).unwrap();
        assert_eq!(
            paths,
            HashSet::from(["new\tname.go".to_owned(), "literal\tname.go".to_owned()])
        );
        assert!(parse_numstat(b"1\t1\t\0only-old\0").is_err());
    }

    #[tokio::test]
    async fn renamed_and_edited_files_remain_renderable_even_when_git_config_disables_renames() {
        let repo = crate::test_support::Repo::new();
        repo.git(&["config", "diff.renames", "false"]);
        let source = (0..30)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        let base = repo.write("old.go", &source);
        repo.git(&["mv", "old.go", "new.go"]);
        let target = repo.write("new.go", &source.replace("line 10", "changed 10"));
        let files = comparison_files(&repo.0, &base, &target).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].change_kind.as_deref(), Some("renamed"));
        assert_eq!(files[0].display_path, "new.go");
        assert!(files[0].renderable);
    }
}
