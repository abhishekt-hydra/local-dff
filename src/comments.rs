//! Durable drafts. Only publish invokes GitHub. An uncertain POST is reconciled
//! by its stable marker, never automatically sent a second time.
use crate::{adapters, review, ApiError, AppState};
use axum::{extract::State, http::StatusCode, Json};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::process::Command;

#[derive(Clone)]
pub struct Store {
    db: Arc<Mutex<Connection>>,
    _lock: Option<Arc<DirectoryLock>>,
}
struct DirectoryLock(std::fs::File);
impl Drop for DirectoryLock {
    fn drop(&mut self) {
        // Release explicitly even while a concurrently forked Git child still
        // holds an inherited descriptor before exec closes it.
        let _ = self.0.unlock();
    }
}
fn storage(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(format!("Local comment storage failed: {error}"))
}
fn conflict() -> ApiError {
    ApiError {
        status: StatusCode::CONFLICT,
        message: "This comment changed or is no longer a draft. Reload comments before continuing."
            .into(),
    }
}
impl Store {
    pub fn open(dir: &Path) -> Result<Self, ApiError> {
        std::fs::create_dir_all(dir).map_err(storage)?;
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("comments.lock"))
            .map_err(storage)?;
        lock.try_lock().map_err(|error| {
            storage(format!(
                "Another local-diffe instance may be using this data directory: {error}"
            ))
        })?;
        let mut store =
            Self::init(Connection::open(dir.join("comments.sqlite3")).map_err(storage)?)?;
        store._lock = Some(Arc::new(DirectoryLock(lock)));
        Ok(store)
    }
    fn init(connection: Connection) -> Result<Self, ApiError> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(storage)?;
        connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS comments (
              id TEXT PRIMARY KEY, pr_url TEXT NOT NULL, body TEXT NOT NULL,
              target TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
              state TEXT NOT NULL CHECK(state IN ('draft','posting','uncertain','posted')),
              remote_url TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              CHECK ((state = 'posted') = (remote_url IS NOT NULL))
            );
            CREATE INDEX IF NOT EXISTS comments_pr ON comments(pr_url);
            UPDATE comments SET state='uncertain' WHERE state='posting';").map_err(storage)?;
        Ok(Self {
            db: Arc::new(Mutex::new(connection)),
            _lock: None,
        })
    }
    #[cfg(test)]
    pub fn memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }
    fn list(&self, pr_url: &str) -> Result<Vec<Comment>, ApiError> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT id, body, target, version, state, remote_url FROM comments WHERE pr_url=? ORDER BY created_at, id").map_err(storage)?;
        let rows = stmt
            .query_map([pr_url], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(storage)?;
        rows.map(|row| {
            let (id, body, target, version, state, remote_url) = row.map_err(storage)?;
            Ok(Comment {
                id,
                body,
                target: serde_json::from_str(&target).map_err(storage)?,
                version,
                state,
                remote_url,
            })
        })
        .collect()
    }
    fn change(
        &self,
        request: &Existing,
        from: &str,
        to: &str,
        url: Option<&str>,
    ) -> Result<(), ApiError> {
        let count = self.db.lock().unwrap().execute(
            "UPDATE comments SET state=?1, remote_url=?2 WHERE id=?3 AND pr_url=?4 AND version=?5 AND state=?6",
            params![to, url, request.id, canonical(&request.pr_url)?, request.version, from],
        ).map_err(storage)?;
        if count != 1 {
            return Err(conflict());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Left,
    Right,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    General,
    Line {
        path: String,
        line: u32,
        side: Side,
        commit_id: String,
    },
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Comment {
    id: String,
    body: String,
    target: Target,
    version: u32,
    state: String,
    remote_url: Option<String>,
}
#[derive(Deserialize)]
pub struct Pull {
    pr_url: String,
}
#[derive(Deserialize)]
pub struct Existing {
    pr_url: String,
    id: String,
    version: u32,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Location {
    Keep,
    General,
    Line {
        session_id: String,
        index: usize,
        line: u32,
        side: Side,
    },
}
#[derive(Deserialize)]
pub struct Save {
    pr_url: String,
    id: Option<String>,
    version: Option<u32>,
    body: String,
    location: Location,
}
fn canonical(url: &str) -> Result<String, ApiError> {
    let reference = crate::parse_github_pr_url(url)?;
    Ok(format!(
        "https://github.com/{}/pull/{}",
        reference.repo.to_lowercase(),
        reference.number
    ))
}
pub async fn list(
    State(state): State<AppState>,
    Json(request): Json<Pull>,
) -> Result<Json<Vec<Comment>>, ApiError> {
    Ok(Json(state.comments.list(&canonical(&request.pr_url)?)?))
}
pub async fn save(
    State(state): State<AppState>,
    Json(request): Json<Save>,
) -> Result<Json<Vec<Comment>>, ApiError> {
    let pr_url = canonical(&request.pr_url)?;
    if request.body.trim().is_empty() || request.body.len() > 60000 {
        return Err(ApiError::bad_request(
            "Write a comment between 1 and 60,000 bytes.",
        ));
    }
    let target = match request.location {
        Location::Keep => {
            state
                .comments
                .list(&pr_url)?
                .into_iter()
                .find(|item| Some(&item.id) == request.id.as_ref())
                .ok_or_else(conflict)?
                .target
        }
        Location::General => Target::General,
        Location::Line {
            session_id,
            index,
            line,
            side,
        } => {
            let reference = crate::parse_github_pr_url(&pr_url)?;
            let session = review::session(&state, &session_id)?;
            if session.comment_pr != Some(reference.number)
                || session.repository != format!("https://github.com/{}", reference.repo)
                || line == 0
            {
                return Err(ApiError::bad_request(
                    "Open this PR's own current comparison to attach a line comment.",
                ));
            }
            let file = session
                .files
                .get(index)
                .ok_or_else(|| ApiError::bad_request("Select a file."))?;
            match side {
                Side::Left => &file.old_path,
                Side::Right => &file.new_path,
            }
            .as_ref()
            .ok_or_else(|| ApiError::bad_request("That side of the file does not exist."))?;
            // GitHub identifies a renamed diff by its new filename even when
            // the comment points at a line on the old side.
            let path = file
                .new_path
                .as_ref()
                .or(file.old_path.as_ref())
                .unwrap()
                .clone();
            Target::Line {
                path,
                line,
                side,
                commit_id: session.target,
            }
        }
    };
    let target = serde_json::to_string(&target).map_err(storage)?;
    {
        let db = state.comments.db.lock().unwrap();
        if let Some(id) = request.id {
            let count = db.execute("UPDATE comments SET body=?1, target=?2, version=version+1 WHERE id=?3 AND pr_url=?4 AND version=?5 AND state='draft'",
                params![request.body, target, id, pr_url, request.version]).map_err(storage)?;
            if count != 1 {
                return Err(conflict());
            }
        } else {
            db.execute(
                "INSERT INTO comments(id, pr_url, body, target, state) VALUES(?1,?2,?3,?4,'draft')",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    pr_url,
                    request.body,
                    target
                ],
            )
            .map_err(storage)?;
        }
    }
    Ok(Json(state.comments.list(&pr_url)?))
}
pub async fn delete(
    State(state): State<AppState>,
    Json(request): Json<Existing>,
) -> Result<Json<Vec<Comment>>, ApiError> {
    let pr_url = canonical(&request.pr_url)?;
    let count = state
        .comments
        .db
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM comments WHERE id=?1 AND pr_url=?2 AND version=?3 AND state='draft'",
            params![request.id, pr_url, request.version],
        )
        .map_err(storage)?;
    if count != 1 {
        return Err(conflict());
    }
    Ok(Json(state.comments.list(&pr_url)?))
}

async fn gh(executable: &str, endpoint: &str, payload: Option<Value>) -> Result<Value, ApiError> {
    let mut command = Command::new(executable);
    command.args(["api", "--hostname", "github.com", endpoint, "--method"]);
    command.arg(if payload.is_some() { "POST" } else { "GET" });
    let input = payload.map(|value| value.to_string().into_bytes());
    if input.is_some() {
        command.args(["--input", "-"]);
    }
    let bytes = tokio::time::timeout(
        Duration::from_secs(30),
        adapters::output(command, "gh", input, 8 * 1024 * 1024),
    )
    .await
    .map_err(|_| ApiError::internal("GitHub request timed out."))?
    .map_err(|error| ApiError::internal(error.to_string()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ApiError::internal(format!("Invalid GitHub response: {error}")))
}
fn remote_url(value: &Value) -> Result<&str, ApiError> {
    value
        .get("html_url")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://github.com/"))
        .ok_or_else(|| ApiError::internal("GitHub did not return a comment URL."))
}
pub async fn publish(
    State(state): State<AppState>,
    Json(request): Json<Existing>,
) -> Result<Json<Vec<Comment>>, ApiError> {
    publish_using(&state.comments, request, "gh")
        .await
        .map(Json)
}
async fn publish_using(
    store: &Store,
    request: Existing,
    executable: &str,
) -> Result<Vec<Comment>, ApiError> {
    let pr_url = canonical(&request.pr_url)?;
    let reference = crate::parse_github_pr_url(&pr_url)?;
    let comment = store
        .list(&pr_url)?
        .into_iter()
        .find(|item| item.id == request.id && item.version == request.version)
        .ok_or_else(conflict)?;
    if comment.state == "posted" {
        return store.list(&pr_url);
    }
    if !matches!(comment.state.as_str(), "draft" | "uncertain") {
        return Err(conflict());
    }
    store.change(&request, &comment.state, "posting", None)?;
    let marker = format!("<!-- local-diffe:{} -->", comment.id);
    let endpoint = match comment.target {
        Target::General => format!(
            "repos/{}/issues/{}/comments",
            reference.repo, reference.number
        ),
        Target::Line { .. } => format!(
            "repos/{}/pulls/{}/comments",
            reference.repo, reference.number
        ),
    };
    let mut attempted = false;
    let result = async {
        if comment.state == "uncertain" {
            // Recovery only reads. An ambiguous network failure must not cause
            // a duplicate notification, even if a retry arrives after restart.
            let mut page = 1;
            loop {
                let response = gh(executable, &format!("{endpoint}?per_page=100&page={page}"), None).await?;
                let rows = response.as_array().ok_or_else(|| ApiError::internal("Invalid GitHub comment list."))?;
                if let Some(found) = rows.iter().find(|row| row.get("body").and_then(Value::as_str).is_some_and(|body| body.ends_with(&marker))) {
                    return Ok(remote_url(found)?.to_owned());
                }
                if rows.len() < 100 { break; }
                page += 1;
            }
            return Err(ApiError::bad_request("No matching comment found on GitHub. This draft remains uncertain; check GitHub before creating another draft."));
        }
        if let Target::Line { commit_id, .. } = &comment.target {
            let pull = gh(executable, &format!("repos/{}/pulls/{}", reference.repo, reference.number), None).await?;
            if pull.pointer("/head/sha").and_then(Value::as_str) != Some(commit_id.as_str()) {
                return Err(ApiError::bad_request("The PR head changed. Reopen the PR and edit this draft to select its current line."));
            }
        }
        let mut payload = json!({"body": format!("{}\n\n{marker}", comment.body)});
        if let Target::Line { path, line, side, commit_id } = &comment.target {
            payload["path"] = json!(path);
            payload["line"] = json!(line);
            payload["side"] = json!(side);
            payload["commit_id"] = json!(commit_id);
        }
        // The posting claim is durable. On restart it becomes uncertain, so a
        // crash after this point requires reconciliation, never a repost.
        attempted = true;
        let response = gh(executable, &endpoint, Some(payload)).await?;
        Ok(remote_url(&response)?.to_owned())
    }.await;
    match result {
        Ok(url) => store.change(&request, "posting", "posted", Some(&url))?,
        Err(error) => {
            // Only a preflight failure is safe to return to editable draft.
            let _ = store.change(
                &request,
                "posting",
                if attempted {
                    "uncertain"
                } else {
                    &comment.state
                },
                None,
            );
            return Err(error);
        }
    }
    store.list(&pr_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{state, Repo};
    const PR: &str = "https://github.com/owner/repo/pull/7";
    async fn draft(state: &AppState, body: &str, location: Location) -> Comment {
        save(
            State(state.clone()),
            Json(Save {
                pr_url: PR.into(),
                id: None,
                version: None,
                body: body.into(),
                location,
            }),
        )
        .await
        .unwrap()
        .0
        .pop()
        .unwrap()
    }
    fn existing(comment: &Comment) -> Existing {
        Existing {
            pr_url: PR.into(),
            id: comment.id.clone(),
            version: comment.version,
        }
    }
    #[cfg(unix)]
    fn fake_gh(repo: &Repo, get: Value, post: &str, fail: bool) -> String {
        use std::os::unix::fs::PermissionsExt;
        let root = repo.0.display();
        std::fs::write(repo.0.join("get.json"), get.to_string()).unwrap();
        std::fs::write(repo.0.join("post.json"), post).unwrap();
        let script = format!("#!/bin/sh\nprintf '%s\\n' \"$6\" >> '{root}/calls'\nif [ \"$6\" = POST ]; then\ncat > '{root}/payload.json'\n{}\ncat '{root}/post.json'\nelse\ncat '{root}/get.json'\nfi\n", if fail { "exit 1" } else { ":" });
        let path = repo.0.join("gh-fixture");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path.to_string_lossy().into_owned()
    }
    #[tokio::test]
    async fn durable_crud_is_pr_scoped_and_rejects_stale_edits() {
        let repo = Repo::new();
        let mut state = state();
        state.comments = Store::open(&repo.0).unwrap();
        assert!(
            Store::open(&repo.0).is_err(),
            "a second server must not reset an active publish"
        );
        let comment = draft(&state, "Keep locally", Location::General).await;
        assert!(state
            .comments
            .list("https://github.com/owner/repo/pull/8")
            .unwrap()
            .is_empty());
        assert!(state
            .comments
            .list("https://github.com/other/repo/pull/7")
            .unwrap()
            .is_empty());
        let edited = save(
            State(state.clone()),
            Json(Save {
                pr_url: PR.into(),
                id: Some(comment.id.clone()),
                version: Some(1),
                body: "Edited locally".into(),
                location: Location::Keep,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(edited[0].body, "Edited locally");
        assert_eq!(edited[0].version, 2);
        assert_eq!(
            delete(State(state.clone()), Json(existing(&comment)))
                .await
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        let directory = repo.0.clone();
        drop(state);
        let mut state = crate::test_support::state();
        state.comments = Store::open(&directory).unwrap();
        let restored = state.comments.list(PR).unwrap().pop().unwrap();
        assert_eq!(restored.body, "Edited locally");
        assert_eq!(restored.state, "draft");
        assert!(delete(State(state), Json(existing(&restored)))
            .await
            .unwrap()
            .0
            .is_empty());
        assert_eq!(
            canonical("https://github.com/Owner/Repo/pull/7/").unwrap(),
            PR
        );
    }
    #[tokio::test]
    async fn inline_locations_use_server_owned_pr_and_file_coordinates() {
        let state = state();
        let mut input = crate::test_support::input();
        input.file.old_path = Some("old.rs".into());
        input.file.new_path = Some("new.rs".into());
        state.sessions.lock().unwrap().insert(
            "current".into(),
            crate::Session {
                comment_pr: Some(7),
                repo: input.repo,
                repository: "https://github.com/owner/repo".into(),
                base: input.base,
                target: "b".repeat(40),
                files: vec![input.file],
                commits: vec![],
                stack: None,
            },
        );
        let comment = draft(
            &state,
            "Inline",
            Location::Line {
                session_id: "current".into(),
                index: 0,
                line: 3,
                side: Side::Left,
            },
        )
        .await;
        assert_eq!(
            comment.target,
            Target::Line {
                path: "new.rs".into(),
                line: 3,
                side: Side::Left,
                commit_id: "b".repeat(40)
            }
        );
        assert_eq!(
            draft(&state, "Body only edit", Location::General)
                .await
                .state,
            "draft"
        );
        let error = save(
            State(state),
            Json(Save {
                pr_url: "https://github.com/owner/repo/pull/8".into(),
                id: None,
                version: None,
                body: "wrong PR".into(),
                location: Location::Line {
                    session_id: "current".into(),
                    index: 0,
                    line: 3,
                    side: Side::Right,
                },
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_publish_sends_exact_saved_body_and_is_idempotent() {
        let repo = Repo::new();
        let state = state();
        let comment = draft(&state, "Review **this**\nwith a newline", Location::General).await;
        let cli = fake_gh(
            &repo,
            json!([]),
            r#"{"html_url":"https://github.com/owner/repo/pull/7#issuecomment-1"}"#,
            false,
        );
        assert!(!repo.0.join("calls").exists());
        let result = publish_using(&state.comments, existing(&comment), &cli)
            .await
            .unwrap();
        assert_eq!(result[0].state, "posted");
        let payload: Value =
            serde_json::from_slice(&std::fs::read(repo.0.join("payload.json")).unwrap()).unwrap();
        assert_eq!(
            payload,
            json!({"body":format!("Review **this**\nwith a newline\n\n<!-- local-diffe:{} -->", comment.id)})
        );
        publish_using(&state.comments, existing(&comment), &cli)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("calls")).unwrap(),
            "POST\n"
        );
        assert!(delete(State(state), Json(existing(&comment)))
            .await
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn uncertain_publish_reconciles_after_restart_without_reposting() {
        let repo = Repo::new();
        let mut state = state();
        state.comments = Store::open(&repo.0).unwrap();
        let comment = draft(&state, "Network trouble", Location::General).await;
        let cli = fake_gh(&repo, json!([]), "", true);
        assert!(publish_using(&state.comments, existing(&comment), &cli)
            .await
            .is_err());
        assert_eq!(state.comments.list(PR).unwrap()[0].state, "uncertain");
        state
            .comments
            .change(&existing(&comment), "uncertain", "posting", None)
            .unwrap();
        drop(state);
        let store = Store::open(&repo.0).unwrap();
        assert!(publish_using(&store, existing(&comment), &cli)
            .await
            .is_err());
        let cli = fake_gh(
            &repo,
            json!([{"body":format!("Network trouble\n\n<!-- local-diffe:{} -->", comment.id), "html_url":"https://github.com/owner/repo/pull/7#issuecomment-9"}]),
            "",
            true,
        );
        let result = publish_using(&store, existing(&comment), &cli)
            .await
            .unwrap();
        assert_eq!(result[0].state, "posted");
        assert_eq!(
            std::fs::read_to_string(repo.0.join("calls")).unwrap(),
            "POST\nGET\nGET\n"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stale_inline_head_is_editable_and_valid_head_posts_original_line() {
        let repo = Repo::new();
        let state = state();
        let comment = draft(&state, "Inline body", Location::General).await;
        let target = Target::Line {
            path: "old.rs".into(),
            line: 8,
            side: Side::Left,
            commit_id: "b".repeat(40),
        };
        state
            .comments
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE comments SET target=?1 WHERE id=?2",
                params![serde_json::to_string(&target).unwrap(), comment.id],
            )
            .unwrap();
        let cli = fake_gh(&repo, json!({"head":{"sha":"a".repeat(40)}}), "", false);
        let error = publish_using(&state.comments, existing(&comment), &cli)
            .await
            .unwrap_err();
        assert!(error.message.contains("head changed"));
        assert_eq!(state.comments.list(PR).unwrap()[0].state, "draft");
        assert!(!repo.0.join("payload.json").exists());
        let cli = fake_gh(
            &repo,
            json!({"head":{"sha":"b".repeat(40)}}),
            r#"{"html_url":"https://github.com/owner/repo/pull/7#discussion_r12"}"#,
            false,
        );
        publish_using(&state.comments, existing(&comment), &cli)
            .await
            .unwrap();
        let payload: Value =
            serde_json::from_slice(&std::fs::read(repo.0.join("payload.json")).unwrap()).unwrap();
        assert_eq!(payload["path"], "old.rs");
        assert_eq!(payload["line"], 8);
        assert_eq!(payload["side"], "LEFT");
        assert_eq!(payload["commit_id"], "b".repeat(40));
        assert_eq!(
            std::fs::read_to_string(repo.0.join("calls")).unwrap(),
            "GET\nGET\nPOST\n"
        );
    }
}
