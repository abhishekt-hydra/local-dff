//! Best-effort, replaceable warming for the active comparison and its PR stack.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::task::JoinHandle;

use crate::{
    domain::DiffInput,
    ports::DiffReader,
    stacks::{Stack, StackMode},
    Session,
};

#[derive(Clone, Default)]
pub struct Warmup {
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl Warmup {
    pub fn start(&self, diffs: Arc<dyn DiffReader>, session: Session) {
        let mut task = self.task.lock().unwrap();
        if let Some(previous) = task.take() {
            previous.abort();
        }
        *task = Some(tokio::spawn(async move {
            let selected = inputs(&session);
            // Download the other members while computing the selected PR. Git's
            // numstat inspection hydrates changed blobs in the persistent clone,
            // including files too large/binary for semantic analysis.
            let (_, rest) = tokio::join!(warm_files(&diffs, selected), prepare_stack(&session),);
            for files in rest {
                warm_files(&diffs, files).await;
            }
        }));
    }
}

fn inputs(session: &Session) -> Vec<DiffInput> {
    session
        .files
        .iter()
        .filter(|file| file.renderable)
        .map(|file| DiffInput {
            repo: session.repo.clone(),
            base: session.base.clone(),
            target: session.target.clone(),
            file: file.clone(),
        })
        .collect()
}

async fn warm_files(diffs: &Arc<dyn DiffReader>, files: Vec<DiffInput>) {
    for input in files {
        // One failure must not prevent the next file from being prepared.
        let _ = diffs.prefetch(input).await;
    }
}

async fn prepare_stack(session: &Session) -> Vec<Vec<DiffInput>> {
    let Some(stack) = &session.stack else {
        return Vec::new();
    };
    let mut prepared = Vec::new();
    // PR mode first: download every member before warming cumulative views.
    for mode in [StackMode::Pr, StackMode::Cumulative] {
        for index in member_order(stack, session) {
            let member = &stack.members[index];
            let base = match mode {
                StackMode::Pr => &member.base,
                StackMode::Cumulative => &member.cumulative_base,
            };
            if *base == session.base && member.head == session.target {
                continue;
            }
            // Comparison preparation can lazily fetch blobs over the network.
            // Bound it, retry on click, and continue if one PR is unavailable.
            match tokio::time::timeout(
                Duration::from_secs(120),
                stack.comparison(&session.repo, member.member.pull.number, mode),
            )
            .await
            {
                Ok(Ok(comparison)) => prepared.push(
                    comparison
                        .files
                        .iter()
                        .filter(|file| file.renderable)
                        .map(|file| DiffInput {
                            repo: session.repo.clone(),
                            base: base.clone(),
                            target: member.head.clone(),
                            file: file.clone(),
                        })
                        .collect(),
                ),
                Ok(Err(error)) => eprintln!(
                    "Could not warm stacked PR #{}: {}",
                    member.member.pull.number, error.message
                ),
                Err(_) => eprintln!(
                    "Timed out warming stacked PR #{}",
                    member.member.pull.number
                ),
            }
        }
    }
    prepared
}

fn member_order(stack: &Stack, session: &Session) -> Vec<usize> {
    let current = stack
        .members
        .iter()
        .position(|member| member.head == session.target)
        .unwrap_or(0);
    let mut order = (0..stack.members.len()).collect::<Vec<_>>();
    order.sort_by_key(|index| index.abs_diff(current));
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{DiffArtifact, DiffKind},
        ports::Task,
        test_support::input,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    struct Reader {
        started: Arc<Notify>,
        calls: Arc<AtomicUsize>,
    }
    impl DiffReader for Reader {
        fn load(&self, _: DiffInput, _: DiffKind) -> Task<Arc<DiffArtifact>> {
            unreachable!("warmup must use low-priority admission")
        }
        fn prefetch(&self, input: DiffInput) -> Task<()> {
            let started = self.started.clone();
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                started.notify_one();
                if input.target == "blocked" {
                    std::future::pending::<()>().await;
                }
                Err(crate::domain::DiffError::InvalidText)
            })
        }
    }

    fn session(target: &str, count: usize) -> Session {
        let input = input();
        let mut files = vec![input.file; count];
        // Metadata-only files are not sent to the semantic engine.
        let mut metadata = files[0].clone();
        metadata.renderable = false;
        files.push(metadata);
        Session {
            repository: "test-repository".into(),
            repo: input.repo,
            base: input.base,
            target: target.into(),
            files,
            commits: Vec::new(),
            stack: None,
        }
    }

    #[tokio::test]
    async fn skips_metadata_and_continues_after_errors() {
        let calls = Arc::new(AtomicUsize::new(0));
        let reader = Arc::new(Reader {
            started: Arc::new(Notify::new()),
            calls: calls.clone(),
        });
        let warmup = Warmup::default();
        warmup.start(reader, session("ready", 3));
        tokio::time::timeout(Duration::from_secs(2), async {
            while calls.load(Ordering::SeqCst) != 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn replacing_comparison_cancels_old_queue() {
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let reader = Arc::new(Reader {
            started: started.clone(),
            calls: calls.clone(),
        });
        let warmup = Warmup::default();
        warmup.start(reader.clone(), session("blocked", 10));
        started.notified().await;
        warmup.start(reader, session("ready", 1));
        tokio::time::timeout(Duration::from_secs(2), async {
            while calls.load(Ordering::SeqCst) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
