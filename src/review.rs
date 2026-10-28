//! Local review evidence. IDs select immutable server-owned versions, never
//! revisions supplied by a browser. The FIFO retains at most 128 identities in
//! memory; restart, eviction, or Git object removal makes a snapshot unavailable.
use crate::{
    domain::FileEntry, ApiError, AppState, ComparisonInfo, Session, StackSelection, StartResponse,
};
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path, time::Duration};
use uuid::Uuid;

pub const SNAPSHOT_LIMIT: usize = 128;
#[derive(Clone)]
struct Snapshot {
    id: String,
    repository: String,
    base: String,
    target: String,
    file: FileEntry,
    topology: Vec<(u64, Option<u64>, String, String)>,
}
#[derive(Default)]
pub struct Snapshots(VecDeque<Snapshot>);
impl Snapshots {
    fn insert(&mut self, mut snapshot: Snapshot) -> String {
        if let Some(existing) = self.0.iter().find(|previous| {
            previous.repository == snapshot.repository
                && previous.base == snapshot.base
                && previous.target == snapshot.target
                && previous.file == snapshot.file
                && previous.topology == snapshot.topology
        }) {
            return existing.id.clone();
        }
        snapshot.id = Uuid::new_v4().to_string();
        let id = snapshot.id.clone();
        if self.0.len() == SNAPSHOT_LIMIT {
            self.0.pop_front();
        }
        self.0.push_back(snapshot);
        id
    }
    fn get(&self, id: &str) -> Result<Snapshot, ApiError> {
        self.0
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(unavailable)
    }
}

pub fn session(state: &AppState, id: &str) -> Result<Session, ApiError> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("This session has expired. Reload the comparison."))
}
fn file(session: &Session, index: usize) -> Result<FileEntry, ApiError> {
    session
        .files
        .get(index)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("Unknown file index."))
}
fn unavailable() -> ApiError {
    ApiError { status: StatusCode::GONE, message: "Reviewed snapshot unavailable: it may have been evicted, the server restarted, or its Git objects are missing. Open and review the current comparison again.".into() }
}
fn topology(session: &Session) -> Vec<(u64, Option<u64>, String, String)> {
    session
        .stack
        .as_ref()
        .map(|stack| {
            stack
                .members
                .iter()
                .map(|member| {
                    (
                        member.member.pull.number,
                        member.member.parent,
                        member.base.clone(),
                        member.head.clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Deserialize)]
pub struct SnapshotRequest {
    id: String,
    index: usize,
}
#[derive(Serialize)]
pub struct SnapshotResponse {
    snapshot_id: String,
    retention_limit: usize,
    retention: &'static str,
}
pub async fn snapshot(
    State(state): State<AppState>,
    Json(request): Json<SnapshotRequest>,
) -> Result<Json<SnapshotResponse>, ApiError> {
    let session = session(&state, &request.id)?;
    let selected = file(&session, request.index)?;
    tokio::time::timeout(
        Duration::from_secs(20),
        ensure_version(&session.repo, &session.target, &selected),
    )
    .await
    .map_err(|_| unavailable())??;
    let snapshot = Snapshot {
        id: String::new(),
        repository: session.repository.clone(),
        base: session.base.clone(),
        target: session.target.clone(),
        file: selected,
        topology: topology(&session),
    };
    let snapshot_id = state.reviews.lock().unwrap().insert(snapshot);
    Ok(Json(SnapshotResponse {
        snapshot_id,
        retention_limit: SNAPSHOT_LIMIT,
        retention:
            "server-memory; oldest evicted; unavailable after restart or missing Git objects",
    }))
}

#[derive(Deserialize)]
pub struct SinceRequest {
    id: String,
    index: usize,
    snapshot_id: String,
}
pub async fn since_review(
    State(state): State<AppState>,
    Json(request): Json<SinceRequest>,
) -> Result<Json<StartResponse>, ApiError> {
    let current = session(&state, &request.id)?;
    let selected = file(&current, request.index)?;
    let previous = state.reviews.lock().unwrap().get(&request.snapshot_id)?;
    if current.repository != previous.repository {
        return Err(ApiError::bad_request(
            "This reviewed snapshot belongs to a different repository.",
        ));
    }
    // Test old object availability without accepting any browser-supplied OID.
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        ensure_version(&current.repo, &previous.target, &previous.file).await?;
        ensure_version(&current.repo, &current.target, &selected).await?;
        let all = crate::comparison_files(&current.repo, &previous.target, &current.target).await?;
        let files = select_since_files(&previous.file, &selected, all)?;
        // A stale review can still compare targets, but its original basis must
        // never be represented as unchanged if its base/dependency snapshot moved.
        let changed = previous.base != current.base || previous.topology != topology(&current);
        let mut comparison = crate::comparison_info(
            crate::RevisionInfo { revision: "previously reviewed target".into(), commit: previous.target.clone() },
            crate::RevisionInfo { revision: "current target".into(), commit: current.target.clone() },
            &files,
            if changed { "Changes since review: reviewed target to current target. The comparison base or stack topology/revisions changed; this is not the current PR's full contribution." } else { "Changes since review: reviewed target to current target, not the current PR's full contribution." }.into(),
            None,
        );
        comparison.kind = Some("since-review");
        let Json(mut response) = crate::create_session(state.clone(), current.repo.clone(), previous.target.clone(), current.target.clone(), files, Some(comparison), crate::CommitLog::default(), None);
        response.repository = current.repository.clone();
        state.sessions.lock().unwrap().get_mut(&response.id).unwrap().repository = current.repository;
        Ok(Json(response))
    }).await;
    result.map_err(|_| ApiError {
        status: StatusCode::GATEWAY_TIMEOUT,
        message: "Changes since review timed out; retry or open the current PR comparison.".into(),
    })?
}

async fn ensure_version(repo: &Path, target: &str, file: &FileEntry) -> Result<(), ApiError> {
    let mut expressions = vec![format!("{target}^{{commit}}")];
    if let Some(path) = &file.new_path {
        expressions.push(format!("{target}:{path}"));
    }
    for expression in expressions {
        let mut command = tokio::process::Command::new("git");
        command
            .current_dir(repo)
            .args(["cat-file", "-e", &expression]);
        crate::adapters::output(command, "Git", None, 1024)
            .await
            .map_err(|_| unavailable())?;
    }
    if file.new_path.is_none() {
        if let Some(path) = &file.old_path {
            let mut command = tokio::process::Command::new("git");
            command.current_dir(repo).args([
                "--literal-pathspecs",
                "ls-tree",
                "--full-tree",
                "-z",
                target,
                "--",
                path,
            ]);
            let output = crate::adapters::output(command, "Git", None, 16 * 1024)
                .await
                .map_err(|_| unavailable())?;
            if !output.is_empty() {
                return Err(ApiError::bad_request("This file is marked deleted but still exists at the target revision; reload a Git-backed comparison."));
            }
        }
    }
    Ok(())
}

fn select_since_files(
    previous: &FileEntry,
    current: &FileEntry,
    files: Vec<FileEntry>,
) -> Result<Vec<FileEntry>, ApiError> {
    let old = previous.new_path.as_deref();
    let new = current.new_path.as_deref();
    let anchor = old.or(previous.old_path.as_deref());
    let destination = new.or(current.old_path.as_deref());
    if anchor == destination {
        if old.is_none() && new.is_none() {
            return Ok(vec![]);
        }
        let relevant = files
            .into_iter()
            .filter(|file| {
                old.is_some() && file.old_path.as_deref() == old
                    || new.is_some() && file.new_path.as_deref() == new
            })
            .collect::<Vec<_>>();
        if relevant.is_empty() {
            return Ok(vec![]);
        }
        if let Some(exact) = relevant
            .iter()
            .find(|file| file.old_path.as_deref() == old && file.new_path.as_deref() == new)
        {
            return Ok(vec![exact.clone()]);
        }
        // Global rename pairing can assign this path's old blob to another
        // destination and call its replacement an add. Compare the explicitly
        // selected path's target versions instead of falsely reporting no change.
        let path = destination
            .ok_or_else(|| ApiError::bad_request("This file has no comparable path."))?;
        return Ok(vec![FileEntry {
            old_path: old.map(str::to_owned),
            new_path: new.map(str::to_owned),
            display_path: path.into(),
            renderable: relevant.iter().any(|file| file.renderable),
            change_kind: Some(
                if old.is_none() {
                    "added"
                } else if new.is_none() {
                    "deleted"
                } else {
                    "modified"
                }
                .into(),
            ),
        }]);
    }
    let matches = files
        .into_iter()
        .filter(|file| {
            if old.is_some() && new.is_some() && old != new {
                file.change_kind.as_deref() == Some("renamed")
                    && file.old_path.as_deref() == old
                    && file.new_path.as_deref() == new
            } else {
                anchor == destination
                    && file.old_path.as_deref() == old
                    && file.new_path.as_deref() == new
            }
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(ApiError::bad_request("Cannot establish this file's continuity with the reviewed snapshot. Choose its matching path or review the current comparison; copies and ambiguous renames are not inferred."));
    }
    Ok(matches)
}

fn github_identity(value: &str) -> Option<String> {
    let value = value.trim().strip_suffix(".git").unwrap_or(value.trim());
    let path = value
        .strip_prefix("https://github.com/")
        .or_else(|| value.strip_prefix("http://github.com/"))
        .or_else(|| value.strip_prefix("git@github.com:"))
        .or_else(|| value.strip_prefix("ssh://git@github.com/"))?;
    let mut parts = path.trim_end_matches('/').split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    if !crate::is_github_slug_part(owner) || !crate::is_github_slug_part(repo) {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}").to_ascii_lowercase())
}
pub fn repository_identity(
    repo: &Path,
    comparison: Option<&ComparisonInfo>,
    stack: Option<&StackSelection>,
) -> String {
    let pull_url = comparison
        .and_then(|value| value.pull_request.as_ref())
        .map(|pull| pull.url.as_str())
        .or_else(|| {
            stack
                .and_then(|selection| selection.stack.members.first())
                .map(|member| member.member.pull.url.as_str())
        });
    if let Some(identity) = pull_url.and_then(github_identity) {
        return identity;
    }
    // Local config only: no network, authentication, or caller-controlled shell.
    if let Ok(output) = std::process::Command::new("git")
        .current_dir(repo)
        .args(["config", "--get", "remote.origin.url"])
        .output()
    {
        if output.status.success() {
            if let Some(identity) = github_identity(&String::from_utf8_lossy(&output.stdout)) {
                return identity;
            }
        }
    }
    std::fs::canonicalize(repo)
        .unwrap_or_else(|_| repo.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{state, Repo};

    async fn open(state: &AppState, repo: &Repo, base: &str, target: &str) -> StartResponse {
        let files = crate::comparison_files(&repo.0, base, target)
            .await
            .unwrap();
        let comparison = crate::comparison_info(
            crate::RevisionInfo {
                revision: "base".into(),
                commit: base.into(),
            },
            crate::RevisionInfo {
                revision: "target".into(),
                commit: target.into(),
            },
            &files,
            "test".into(),
            None,
        );
        crate::create_session(
            state.clone(),
            repo.0.clone(),
            base.into(),
            target.into(),
            files,
            Some(comparison),
            crate::CommitLog::default(),
            None,
        )
        .0
    }
    async fn retain(state: &AppState, id: &str) -> String {
        snapshot(
            State(state.clone()),
            Json(SnapshotRequest {
                id: id.into(),
                index: 0,
            }),
        )
        .await
        .unwrap()
        .0
        .snapshot_id
    }
    async fn since(
        state: &AppState,
        id: &str,
        snapshot_id: &str,
    ) -> Result<Json<StartResponse>, ApiError> {
        since_review(
            State(state.clone()),
            Json(SinceRequest {
                id: id.into(),
                index: 0,
                snapshot_id: snapshot_id.into(),
            }),
        )
        .await
    }

    #[tokio::test]
    async fn targets_not_merge_bases_and_topology_changes_are_explicit() {
        let repo = Repo::new();
        let root = repo.write("file.go", "package p\nfunc A() { base() }\n");
        let first = repo.write("file.go", "package p\nfunc A() { first() }\n");
        let state = state();
        let reviewed = open(&state, &repo, &root, &first).await;
        let snapshot_id = retain(&state, &reviewed.id).await;
        assert_eq!(retain(&state, &reviewed.id).await, snapshot_id);
        let second = repo.write("file.go", "package p\nfunc A() { second() }\n");
        let current = open(&state, &repo, &first, &second).await;
        let Json(response) = since(&state, &current.id, &snapshot_id).await.unwrap();
        let comparison = response.comparison.unwrap();
        assert_eq!(comparison.kind, Some("since-review"));
        assert_eq!(comparison.base.commit, first);
        assert_eq!(comparison.target.commit, second);
        assert!(comparison
            .description
            .contains("topology/revisions changed"));
        assert!(response.stack.is_none());
        assert_eq!(response.repository, current.repository);
        assert_eq!(session(&state, &response.id).unwrap().base, first);
    }

    #[tokio::test]
    async fn renames_deletions_and_unchanged_targets_have_truthful_file_pairs() {
        let repo = Repo::new();
        let root = repo.write("old.go", "package p\nfunc A() { base() }\n");
        let first = repo.write("old.go", "package p\nfunc A() { first() }\n");
        let state = state();
        let reviewed = open(&state, &repo, &root, &first).await;
        let snapshot_id = retain(&state, &reviewed.id).await;
        let same = since(&state, &reviewed.id, &snapshot_id).await.unwrap().0;
        assert!(same.files.is_empty());
        repo.git(&["mv", "old.go", "new.go"]);
        let renamed = repo.commit();
        let current = open(&state, &repo, &first, &renamed).await;
        let renamed_result = since(&state, &current.id, &snapshot_id).await.unwrap().0;
        assert_eq!(renamed_result.files[0].old_path.as_deref(), Some("old.go"));
        assert_eq!(renamed_result.files[0].new_path.as_deref(), Some("new.go"));
        assert_eq!(
            renamed_result.files[0].change_kind.as_deref(),
            Some("renamed")
        );
        let renamed_snapshot = retain(&state, &current.id).await;
        repo.git(&["rm", "new.go"]);
        let deleted = repo.commit();
        let current = open(&state, &repo, &renamed, &deleted).await;
        let result = since(&state, &current.id, &renamed_snapshot)
            .await
            .unwrap()
            .0;
        assert_eq!(result.files[0].old_path.as_deref(), Some("new.go"));
        assert_eq!(result.files[0].new_path, None);
        // A reviewed absence can be compared with an explicitly added same path.
        let deleted_snapshot = retain(&state, &current.id).await;
        let recreated = repo.write("new.go", "package p\nfunc B() {}\n");
        let current = open(&state, &repo, &deleted, &recreated).await;
        let result = since(&state, &current.id, &deleted_snapshot)
            .await
            .unwrap()
            .0;
        assert_eq!(result.files[0].old_path, None);
        assert_eq!(result.files[0].new_path.as_deref(), Some("new.go"));
    }

    #[tokio::test]
    async fn same_path_replacement_is_not_lost_to_global_rename_pairing() {
        let repo = Repo::new();
        let root = repo.write("file.go", "base\n");
        let first = repo.write("file.go", "package p\nfunc Earlier() {}\n");
        let state = state();
        let reviewed = open(&state, &repo, &root, &first).await;
        let snapshot_id = retain(&state, &reviewed.id).await;
        std::fs::write(repo.0.join("moved.go"), "package p\nfunc Earlier() {}\n").unwrap();
        let second = repo.write(
            "file.go",
            "package q\nfunc EntirelyDifferent() { other() }\n",
        );
        let current = open(&state, &repo, &first, &second).await;
        let index = current
            .files
            .iter()
            .position(|file| file.new_path.as_deref() == Some("file.go"))
            .unwrap();
        let result = since_review(
            State(state.clone()),
            Json(SinceRequest {
                id: current.id,
                index,
                snapshot_id,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].old_path.as_deref(), Some("file.go"));
        assert_eq!(result.files[0].new_path.as_deref(), Some("file.go"));
        let input = session(&state, &result.id).unwrap();
        let contents = crate::ports::DiffSource::contents(
            &crate::adapters::GitDiffSource,
            crate::domain::DiffInput {
                repo: input.repo,
                base: input.base,
                target: input.target,
                file: result.files[0].clone(),
            },
        )
        .await
        .unwrap();
        assert!(contents.old.contains("Earlier"));
        assert!(contents.new.contains("EntirelyDifferent"));
    }

    #[tokio::test]
    async fn unrelated_file_and_copy_do_not_reuse_a_retained_file_snapshot() {
        let repo = Repo::new();
        let root = repo.write("file.go", "base\n");
        let target = repo.write("file.go", "reviewed\n");
        let state = state();
        let reviewed = open(&state, &repo, &root, &target).await;
        let snapshot_id = retain(&state, &reviewed.id).await;
        let copied = repo.write("zz-copy.go", "reviewed\n");
        let current = open(&state, &repo, &target, &copied).await;
        assert!(since(&state, &current.id, &snapshot_id)
            .await
            .err()
            .unwrap()
            .message
            .contains("continuity"));
        assert!(snapshot(
            State(state.clone()),
            Json(SnapshotRequest {
                id: current.id,
                index: usize::MAX
            })
        )
        .await
        .is_err());
        let original = reviewed.files[0].clone();
        let copy = FileEntry {
            old_path: Some("file.go".into()),
            new_path: Some("zz-copy.go".into()),
            display_path: "zz-copy.go".into(),
            renderable: true,
            change_kind: Some("copied".into()),
        };
        assert!(select_since_files(&original, &copy, vec![copy.clone()]).is_err());
    }

    #[tokio::test]
    async fn snapshot_eviction_restart_missing_objects_and_repository_isolation() {
        let repo = Repo::new();
        let root = repo.write("file.go", "base");
        let target = repo.write("file.go", "reviewed");
        let state = state();
        let review = open(&state, &repo, &root, &target).await;
        let id = retain(&state, &review.id).await;
        let mut stored = state.reviews.lock().unwrap();
        let original = stored.get(&id).unwrap();
        for i in 0..SNAPSHOT_LIMIT {
            let mut entry = original.clone();
            entry.target = format!("retained-{i}");
            stored.insert(entry);
        }
        assert_eq!(stored.0.len(), SNAPSHOT_LIMIT);
        assert_eq!(stored.get(&id).err().unwrap().status, StatusCode::GONE);
        drop(stored);
        assert_eq!(
            since(&state, &review.id, &id).await.err().unwrap().status,
            StatusCode::GONE
        );
        state.reviews.lock().unwrap().0.clear();
        let id = retain(&state, &review.id).await;
        state.reviews.lock().unwrap().0[0].target = "0".repeat(40);
        assert_eq!(
            since(&state, &review.id, &id).await.err().unwrap().status,
            StatusCode::GONE
        );
        state.reviews.lock().unwrap().0.clear();
        let id = retain(&state, &review.id).await;
        state
            .sessions
            .lock()
            .unwrap()
            .get_mut(&review.id)
            .unwrap()
            .repository = "other-repository".into();
        assert!(since(&state, &review.id, &id)
            .await
            .err()
            .unwrap()
            .message
            .contains("different repository"));
        state.reviews.lock().unwrap().0.clear();
        assert_eq!(
            since(&state, &review.id, &id).await.err().unwrap().status,
            StatusCode::GONE
        );
    }

    #[test]
    fn repository_identity_uses_known_github_origin_or_canonical_filesystem() {
        for value in [
            "https://github.com/Owner/Repo.git",
            "git@github.com:Owner/Repo.git",
            "ssh://git@github.com/Owner/Repo.git",
            "https://github.com/Owner/Repo/pull/123",
        ] {
            assert_eq!(
                github_identity(value).as_deref(),
                Some("https://github.com/owner/repo")
            );
        }
        let repo = Repo::new();
        assert_eq!(
            repository_identity(&repo.0.join("."), None, None),
            std::fs::canonicalize(&repo.0).unwrap().to_string_lossy()
        );
        repo.git(&["remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
        assert_eq!(
            repository_identity(&repo.0, None, None),
            "https://github.com/owner/repo"
        );
        assert!(github_identity("https://evil.test/Owner/Repo").is_none());
    }
}
