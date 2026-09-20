use crate::{
    domain::{DiffArtifact, DiffError, DiffKey},
    ports::{DiffStore, Task},
};
use foyer::{Cache, CacheBuilder};
use std::sync::Arc;

pub struct FoyerDiffStore {
    cache: Cache<DiffKey, Arc<DiffArtifact>>,
}

impl FoyerDiffStore {
    pub fn new(capacity_bytes: usize) -> Self {
        let cache = CacheBuilder::new(capacity_bytes)
            .with_name("diff-results")
            .with_shards(1)
            .with_weighter(|key: &DiffKey, value: &Arc<DiffArtifact>| {
                value.estimated_bytes()
                    + key.input.repo.as_os_str().len()
                    + key.input.base.len()
                    + key.input.target.len()
                    + key.input.file.display_path.len()
                    + key.input.file.old_path.as_ref().map_or(0, String::len)
                    + key.input.file.new_path.as_ref().map_or(0, String::len)
            })
            .build();
        Self { cache }
    }
}

impl DiffStore for FoyerDiffStore {
    fn get_or_load(&self, key: DiffKey, load: Task<Arc<DiffArtifact>>) -> Task<Arc<DiffArtifact>> {
        let cache = self.cache.clone();
        Box::pin(async move {
            cache
                .get_or_fetch(&key, || async move {
                    load.await.map_err(|error| {
                        foyer::Error::new(foyer::ErrorKind::External, "diff load failed")
                            .with_source(error)
                    })
                })
                .await
                .map(|entry| entry.value().clone())
                .map_err(|error| {
                    let mut source: &(dyn std::error::Error + 'static) = &error;
                    loop {
                        if let Some(error) = source.downcast_ref::<DiffError>() {
                            break error.clone();
                        }
                        match source.source() {
                            Some(next) => source = next,
                            None => break DiffError::Storage(error.to_string()),
                        }
                    }
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{domain::DiffKind, test_support::input};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn coalesces_concurrent_misses_and_reuses_results() {
        let store = FoyerDiffStore::new(1024 * 1024);
        let key = DiffKey {
            input: input(),
            kind: DiffKind::Text,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let load = || {
            let calls = calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                Ok(Arc::new(DiffArtifact::Text("patch".into())))
            }) as Task<Arc<DiffArtifact>>
        };
        let (a, b) = tokio::join!(
            store.get_or_load(key.clone(), load()),
            store.get_or_load(key.clone(), load())
        );
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
        store.get_or_load(key, load()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failures_keep_their_type_and_can_be_retried() {
        let store = FoyerDiffStore::new(1024 * 1024);
        let key = DiffKey {
            input: input(),
            kind: DiffKind::Semantic,
        };
        let error = store
            .get_or_load(key.clone(), Box::pin(async { Err(DiffError::Timeout) }))
            .await
            .unwrap_err();
        assert_eq!(error, DiffError::Timeout);
        let result = store
            .get_or_load(
                key,
                Box::pin(async { Ok(Arc::new(DiffArtifact::Text("retry".into()))) }),
            )
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn modes_and_commits_do_not_share_entries_and_capacity_is_bounded() {
        let store = FoyerDiffStore::new(8192);
        for index in 0..20 {
            let mut request = input();
            request.target = index.to_string();
            for kind in [DiffKind::Text, DiffKind::Semantic] {
                let key = DiffKey {
                    input: request.clone(),
                    kind,
                };
                store
                    .get_or_load(
                        key,
                        Box::pin(async { Ok(Arc::new(DiffArtifact::Text("x".repeat(2048)))) }),
                    )
                    .await
                    .unwrap();
            }
        }
        assert!(store.cache.usage() <= store.cache.capacity());
        assert!(store.cache.entries() < 40);
    }
}
