//! Use-case orchestration: policy, deadlines, and independent work queues.
use crate::{
    domain::{
        DiffArtifact, DiffError, DiffInput, DiffKey, DiffKind, SemanticInput, SemanticResponse,
    },
    ports::{DiffReader, DiffSource, DiffStore, SemanticEngine, Task},
};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};

#[derive(Clone)]
pub struct DiffService {
    source: Arc<dyn DiffSource>,
    engine: Arc<dyn SemanticEngine>,
    store: Arc<dyn DiffStore>,
    text_slots: Arc<Semaphore>,
    semantic_slots: Arc<Semaphore>,
    background_slot: Arc<Semaphore>,
    deadline: Duration,
}

impl DiffService {
    pub fn new(
        source: Arc<dyn DiffSource>,
        engine: Arc<dyn SemanticEngine>,
        store: Arc<dyn DiffStore>,
    ) -> Self {
        Self {
            source,
            engine,
            store,
            text_slots: Arc::new(Semaphore::new(4)),
            semantic_slots: Arc::new(Semaphore::new(2)),
            background_slot: Arc::new(Semaphore::new(1)),
            deadline: Duration::from_secs(20),
        }
    }
}

impl DiffReader for DiffService {
    fn prefetch(&self, input: DiffInput) -> Task<()> {
        let service = self.clone();
        Box::pin(async move {
            let permit = service
                .background_slot
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| DiffError::Timeout)?;
            service
                .load_admitted(input, DiffKind::Semantic, Some(permit))
                .await?;
            Ok(())
        })
    }

    fn load(&self, input: DiffInput, kind: DiffKind) -> Task<Arc<DiffArtifact>> {
        self.load_admitted(input, kind, None)
    }
}

impl DiffService {
    fn load_admitted(
        &self,
        input: DiffInput,
        kind: DiffKind,
        background_permit: Option<OwnedSemaphorePermit>,
    ) -> Task<Arc<DiffArtifact>> {
        let source = self.source.clone();
        let engine = self.engine.clone();
        let slots = match kind {
            DiffKind::Text => self.text_slots.clone(),
            DiffKind::Semantic => self.semantic_slots.clone(),
        };
        let deadline = self.deadline;
        let key = DiffKey {
            input: input.clone(),
            kind,
        };
        self.store.get_or_load(
            key,
            Box::pin(async move {
                // Foyer may finish a load after its caller is cancelled. Keep
                // background admission until that load actually finishes.
                let _background_permit = background_permit;
                timeout(deadline, async move {
                    let _permit = slots.acquire().await.map_err(|_| DiffError::Timeout)?;
                    let artifact = match kind {
                        DiffKind::Text => DiffArtifact::Text(source.text_diff(input).await?),
                        DiffKind::Semantic => {
                            let contents = source.contents(input.clone()).await?;
                            let extension = std::path::Path::new(
                                input
                                    .file
                                    .new_path
                                    .as_ref()
                                    .or(input.file.old_path.as_ref())
                                    .map(String::as_str)
                                    .unwrap_or(""),
                            )
                            .extension()
                            .map(|s| format!(".{}", s.to_string_lossy()))
                            .unwrap_or_default();
                            let old_content = contents.old.clone();
                            let new_content = contents.new.clone();
                            let semantic = engine
                                .compare(SemanticInput {
                                    contents,
                                    extension,
                                })
                                .await?;
                            DiffArtifact::Semantic(SemanticResponse {
                                file: input.file,
                                old_content,
                                new_content,
                                semantic,
                            })
                        }
                    };
                    Ok(Arc::new(artifact))
                })
                .await
                .map_err(|_| DiffError::Timeout)?
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{domain::FileContents, storage::FoyerDiffStore, test_support::input};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Source {
        reads: Arc<AtomicUsize>,
    }
    impl DiffSource for Source {
        fn text_diff(&self, _: DiffInput) -> Task<String> {
            Box::pin(async { Ok("plain patch".into()) })
        }
        fn contents(&self, input: DiffInput) -> Task<FileContents> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(FileContents {
                    old: "old".into(),
                    new: input.target,
                })
            })
        }
    }
    struct SlowEngine;
    impl SemanticEngine for SlowEngine {
        fn compare(&self, _: SemanticInput) -> Task<serde_json::Value> {
            Box::pin(std::future::pending())
        }
    }

    struct GatedEngine {
        started: tokio::sync::mpsc::UnboundedSender<String>,
        release: Arc<tokio::sync::Notify>,
    }
    impl SemanticEngine for GatedEngine {
        fn compare(&self, input: SemanticInput) -> Task<serde_json::Value> {
            let started = self.started.clone();
            let release = self.release.clone();
            Box::pin(async move {
                started.send(input.contents.new.clone()).unwrap();
                if input.contents.new == "background" {
                    release.notified().await;
                }
                Ok(serde_json::json!({}))
            })
        }
    }

    fn request(target: &str) -> DiffInput {
        let mut input = input();
        input.target = target.into();
        input
    }

    #[tokio::test]
    async fn clicks_bypass_queued_background_work_and_reuse_warmed_results() {
        let reads = Arc::new(AtomicUsize::new(0));
        let (started, mut events) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let service = DiffService::new(
            Arc::new(Source {
                reads: reads.clone(),
            }),
            Arc::new(GatedEngine {
                started,
                release: release.clone(),
            }),
            Arc::new(FoyerDiffStore::new(1024 * 1024)),
        );
        let background = tokio::spawn(service.prefetch(request("background")));
        assert_eq!(events.recv().await.unwrap(), "background");
        let queued = tokio::spawn(service.prefetch(request("clicked")));
        // Give the queued prefetch a chance to acquire admission. It must not
        // occupy a cache key while waiting behind the running background job.
        tokio::task::yield_now().await;
        let clicked = tokio::time::timeout(
            Duration::from_secs(2),
            service.load(request("clicked"), DiffKind::Semantic),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(events.recv().await.unwrap(), "clicked");
        // A click on an already-running warmup joins that exact computation.
        let joined = tokio::spawn(service.load(request("background"), DiffKind::Semantic));
        release.notify_one();
        background.await.unwrap().unwrap();
        queued.await.unwrap().unwrap();
        let warmed = joined.await.unwrap().unwrap();
        let revisit = service
            .load(request("background"), DiffKind::Semantic)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&warmed, &revisit));
        let clicked_again = service
            .load(request("clicked"), DiffKind::Semantic)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&clicked, &clicked_again));
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancellation_keeps_background_admission_until_the_fetch_finishes() {
        let (started, mut events) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let service = DiffService::new(
            Arc::new(Source {
                reads: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(GatedEngine {
                started,
                release: release.clone(),
            }),
            Arc::new(FoyerDiffStore::new(1024 * 1024)),
        );
        let background = tokio::spawn(service.prefetch(request("background")));
        assert_eq!(events.recv().await.unwrap(), "background");
        background.abort();
        let _ = background.await;
        // Foyer owns the started fetch even after its original caller leaves.
        assert_eq!(service.background_slot.available_permits(), 0);
        let next = tokio::spawn(service.prefetch(request("next")));
        tokio::task::yield_now().await;
        assert!(events.try_recv().is_err());
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), next)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(events.recv().await.unwrap(), "next");
        assert_eq!(service.background_slot.available_permits(), 1);
    }

    #[tokio::test]
    async fn text_remains_available_while_semantic_analysis_times_out() {
        let reads = Arc::new(AtomicUsize::new(0));
        let mut service = DiffService::new(
            Arc::new(Source {
                reads: reads.clone(),
            }),
            Arc::new(SlowEngine),
            Arc::new(FoyerDiffStore::new(1024 * 1024)),
        );
        service.deadline = Duration::from_millis(30);
        let (semantic, text) = tokio::join!(
            service.load(input(), DiffKind::Semantic),
            service.load(input(), DiffKind::Text)
        );
        assert_eq!(semantic.unwrap_err(), DiffError::Timeout);
        assert!(
            matches!(text.unwrap().as_ref(), DiffArtifact::Text(text) if text == "plain patch")
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(service.semantic_slots.available_permits(), 2);
    }
}
