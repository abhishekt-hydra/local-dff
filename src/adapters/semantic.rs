use super::process::output;
use crate::{
    domain::{DiffError, SemanticInput},
    ports::{SemanticEngine, Task},
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::process::Command;

pub struct SemanticCli {
    binary: PathBuf,
}
impl SemanticCli {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }
}

impl SemanticEngine for SemanticCli {
    fn compare(&self, input: SemanticInput) -> Task<Value> {
        let binary = self.binary.clone();
        Box::pin(async move {
            let payload = serde_json::to_vec(&json!({
                "old_content": input.contents.old, "new_content": input.contents.new,
                "extension": input.extension, "fallback": true,
                "options": { "ignore_comments": false }
            }))
            .map_err(|e| DiffError::InvalidSemantic(e.to_string()))?;
            let mut command = Command::new(binary);
            command.arg("--diff-stdin");
            let bytes = output(command, "SemanticDiff", Some(payload), 16 * 1024 * 1024).await?;
            serde_json::from_slice(&bytes).map_err(|e| DiffError::InvalidSemantic(e.to_string()))
        })
    }
}
