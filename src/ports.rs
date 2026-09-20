//! Application boundaries. Adapters implement these contracts; handlers depend on them.
use crate::domain::{
    DiffArtifact, DiffError, DiffInput, DiffKey, DiffKind, FileContents, SemanticInput,
};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};

pub type Task<T> = Pin<Box<dyn Future<Output = Result<T, DiffError>> + Send + 'static>>;

pub trait DiffSource: Send + Sync {
    fn text_diff(&self, input: DiffInput) -> Task<String>;
    fn contents(&self, input: DiffInput) -> Task<FileContents>;
}

pub trait SemanticEngine: Send + Sync {
    fn compare(&self, input: SemanticInput) -> Task<Value>;
}

pub trait DiffStore: Send + Sync {
    /// Cache successes only. Coalesce simultaneous loads for the same immutable key.
    /// Implementations may finish bounded loads after a caller disconnects.
    fn get_or_load(&self, key: DiffKey, load: Task<Arc<DiffArtifact>>) -> Task<Arc<DiffArtifact>>;
}

pub trait DiffReader: Send + Sync {
    fn load(&self, input: DiffInput, kind: DiffKind) -> Task<Arc<DiffArtifact>>;
}
