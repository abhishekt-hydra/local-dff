//! Use-case orchestration: policy, deadlines, and independent work queues.
use crate::{
    domain::{
        DiffArtifact, DiffError, DiffInput, DiffKey, DiffKind, SemanticInput, SemanticResponse,
    },
    ports::{DiffReader, DiffSource, DiffStore, SemanticEngine, Task},
};
use std::{sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::timeout};

pub struct DiffService {
    source: Arc<dyn DiffSource>,
    engine: Arc<dyn SemanticEngine>,
    store: Arc<dyn DiffStore>,
    text_slots: Arc<Semaphore>,
    semantic_slots: Arc<Semaphore>,
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
            deadline: Duration::from_secs(20),
        }
    }
}

impl DiffReader for DiffService {
    fn load(&self, input: DiffInput, kind: DiffKind) -> Task<Arc<DiffArtifact>> {
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
        fn contents(&self, _: DiffInput) -> Task<FileContents> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(FileContents {
                    old: "old".into(),
                    new: "new".into(),
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
