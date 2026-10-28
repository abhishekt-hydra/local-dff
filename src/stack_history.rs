//! Snapshot-local metadata preparation. Polling never waits for Git or for all
//! stack members, and failures remain failed until explicitly retried.
use crate::{
    domain::FileEntry,
    stacks::{Stack, StackMode},
    ApiError, AppState,
};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Debug, Default)]
pub struct Preparation(Mutex<Progress>);
#[derive(Debug, Default)]
struct Progress {
    worker: Option<tokio::task::AbortHandle>,
    errors: HashMap<u64, String>,
}

#[derive(Deserialize)]
pub struct Request {
    id: String,
    #[serde(default)]
    retry: bool,
}
#[derive(Serialize)]
pub struct History {
    repository: String,
    members: Vec<Member>,
}
#[derive(Serialize)]
pub struct Member {
    number: u64,
    parent: Option<u64>,
    depth: usize,
    base: String,
    target: String,
    state: &'static str,
    files: Vec<FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub async fn history(
    State(state): State<AppState>,
    Json(request): Json<Request>,
) -> Result<Json<History>, ApiError> {
    let session = crate::review::session(&state, &request.id)?;
    let stack = session
        .stack
        .ok_or_else(|| ApiError::bad_request("This comparison is not part of a PR stack."))?;
    stack.prepare_history(session.repo, request.retry);
    Ok(Json(History {
        repository: session.repository,
        members: stack.history_members(),
    }))
}

impl Stack {
    pub fn history_members(&self) -> Vec<Member> {
        let progress = self.history.0.lock().unwrap();
        self.members
            .iter()
            .map(|member| {
                let prepared = member.pr_comparison.get();
                let error = if prepared.is_none() {
                    progress.errors.get(&member.member.pull.number).cloned()
                } else {
                    None
                };
                Member {
                    number: member.member.pull.number,
                    parent: member.member.parent,
                    depth: member.member.depth,
                    base: member.base.clone(),
                    target: member.head.clone(),
                    state: if prepared.is_some() {
                        "ready"
                    } else if error.is_some() {
                        "failed"
                    } else {
                        "pending"
                    },
                    files: prepared
                        .map(|value| value.files.clone())
                        .unwrap_or_default(),
                    error,
                }
            })
            .collect()
    }

    pub fn prepare_history(self: &Arc<Self>, repo: PathBuf, retry: bool) {
        let mut progress = self.history.0.lock().unwrap();
        if retry {
            progress.errors.clear();
        }
        if progress
            .worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
        {
            return;
        }
        if self.members.iter().all(|member| {
            member.pr_comparison.get().is_some()
                || progress.errors.contains_key(&member.member.pull.number)
        }) {
            return;
        }
        let stack = self.clone();
        let worker = tokio::spawn(async move {
            loop {
                let next = {
                    let progress = stack.history.0.lock().unwrap();
                    stack
                        .members
                        .iter()
                        .find(|member| {
                            member.pr_comparison.get().is_none()
                                && !progress.errors.contains_key(&member.member.pull.number)
                        })
                        .map(|member| member.member.pull.number)
                };
                let Some(number) = next else {
                    break;
                };
                // OnceCell coalesces foreground opens, warmup, and history reads.
                // Only one member per stack is prepared by this worker at a time.
                let result = tokio::time::timeout(
                    Duration::from_secs(120),
                    stack.comparison(&repo, number, StackMode::Pr),
                )
                .await;
                let error = match result {
                    Ok(Ok(_)) => None,
                    Ok(Err(error)) => Some(error.message),
                    Err(_) => {
                        Some("Stack metadata preparation timed out. Retry this history.".into())
                    }
                };
                let mut progress = stack.history.0.lock().unwrap();
                if let Some(error) = error {
                    progress.errors.insert(number, error);
                } else {
                    progress.errors.remove(&number);
                }
            }
        });
        // Keep only a lightweight handle. A cancelled/panicked worker can be
        // detected on the next poll instead of leaving a stale running flag.
        progress.worker = Some(worker.abort_handle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{stack_fixture, state};

    async fn settled(stack: &Stack) -> Vec<Member> {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let members = stack.history_members();
                if members.iter().all(|member| member.state != "pending") {
                    return members;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn nonblocking_history_is_pr_local_and_cumulative_tip_excludes_reverts_and_siblings() {
        let (repo, stack) = stack_fixture().await;
        let state = state();
        state.sessions.lock().unwrap().insert(
            "stack".into(),
            crate::Session {
                repository: "https://github.com/owner/repo".into(),
                repo: repo.0.clone(),
                base: stack.members[0].base.clone(),
                target: stack.members[0].head.clone(),
                files: vec![],
                commits: vec![],
                stack: Some(stack.clone()),
            },
        );
        let Json(response) = history(
            State(state.clone()),
            Json(Request {
                id: "stack".into(),
                retry: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(response.repository, "https://github.com/owner/repo");
        assert!(response
            .members
            .iter()
            .all(|member| member.state == "pending"));
        // Repeat polls reuse the one worker and the same snapshot's OnceCells.
        for _ in 0..3 {
            stack.prepare_history(repo.0.clone(), false);
        }
        let members = settled(&stack).await;
        assert!(members.iter().all(|member| member.state == "ready"));
        let second = members.iter().find(|member| member.number == 2).unwrap();
        assert_eq!(second.parent, Some(1));
        assert!(second
            .files
            .iter()
            .any(|file| file.display_path == "shared.go"));
        assert!(second
            .files
            .iter()
            .any(|file| file.display_path == "second.go"));
        assert!(!second
            .files
            .iter()
            .any(|file| file.display_path == "third.go"));
        let final_second = stack
            .comparison(&repo.0, 2, StackMode::Cumulative)
            .await
            .unwrap();
        assert_eq!(final_second.files.len(), 1);
        assert_eq!(final_second.files[0].display_path, "second.go");
        let final_third = stack
            .comparison(&repo.0, 3, StackMode::Cumulative)
            .await
            .unwrap();
        assert!(!final_third
            .files
            .iter()
            .any(|file| file.display_path == "second.go"));
        assert!(final_third
            .files
            .iter()
            .any(|file| file.display_path == "shared.go"));
        // Published targets remain the resolved snapshot despite mutable branch refs.
        let original_target = second.target.clone();
        repo.git(&["update-ref", "refs/pull/2/head", &stack.members[2].head]);
        assert_eq!(
            stack
                .history_members()
                .iter()
                .find(|member| member.number == 2)
                .unwrap()
                .target,
            original_target
        );
    }

    #[tokio::test]
    async fn cancelled_worker_restarts_on_the_next_poll() {
        let (repo, stack) = stack_fixture().await;
        stack.prepare_history(repo.0.clone(), false);
        let worker = stack.history.0.lock().unwrap().worker.clone().unwrap();
        worker.abort();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !worker.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(stack
            .history_members()
            .iter()
            .all(|member| member.state == "pending"));
        stack.prepare_history(repo.0.clone(), false);
        assert!(settled(&stack)
            .await
            .iter()
            .all(|member| member.state == "ready"));
    }

    #[tokio::test]
    async fn failed_members_stay_failed_until_explicit_retry() {
        let (repo, stack) = stack_fixture().await;
        stack.prepare_history(repo.0.join("missing-repository"), false);
        let failed = settled(&stack).await;
        assert!(failed.iter().all(|member| member.state == "failed"
            && member.error.is_some()
            && member.files.is_empty()));
        stack.prepare_history(repo.0.clone(), false);
        assert!(stack
            .history_members()
            .iter()
            .all(|member| member.state == "failed"));
        stack.prepare_history(repo.0.clone(), true);
        assert!(settled(&stack)
            .await
            .iter()
            .all(|member| member.state == "ready"));
    }
}
