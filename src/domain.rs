//! Diff models and errors. No HTTP, cache, or process dependencies.
use std::{fmt, path::PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize, PartialEq, Eq, Hash)]
pub struct FileEntry {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub display_path: String,
    pub renderable: bool,
}

/// Revisions must be resolved commit IDs before constructing a request.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DiffInput {
    pub repo: PathBuf,
    pub base: String,
    pub target: String,
    pub file: FileEntry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DiffKind {
    Text,
    Semantic,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DiffKey {
    pub input: DiffInput,
    pub kind: DiffKind,
}

pub struct FileContents {
    pub old: String,
    pub new: String,
}

pub struct SemanticInput {
    pub contents: FileContents,
    pub extension: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SemanticResponse {
    pub file: FileEntry,
    pub old_content: String,
    pub new_content: String,
    pub semantic: Value,
}

#[derive(Debug)]
pub enum DiffArtifact {
    Text(String),
    Semantic(SemanticResponse),
}

impl DiffArtifact {
    /// Conservative weight for owned strings, JSON nodes, and allocation overhead.
    pub fn estimated_bytes(&self) -> usize {
        fn json_bytes(value: &Value) -> usize {
            std::mem::size_of::<Value>()
                + match value {
                    Value::String(s) => s.capacity(),
                    Value::Array(items) => items.iter().map(json_bytes).sum(),
                    Value::Object(items) => items
                        .iter()
                        .map(|(k, v)| k.capacity() + 128 + json_bytes(v))
                        .sum(),
                    _ => 0,
                }
        }
        1024 + match self {
            Self::Text(text) => text.capacity(),
            Self::Semantic(result) => {
                result.old_content.capacity()
                    + result.new_content.capacity()
                    + json_bytes(&result.semantic)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffError {
    Timeout,
    TooLarge {
        limit: usize,
    },
    InvalidText,
    Process {
        program: &'static str,
        message: String,
    },
    InvalidSemantic(String),
    Storage(String),
    UnexpectedArtifact,
}

impl fmt::Display for DiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => write!(f, "Diff processing timed out. Retry or use Text diff."),
            Self::TooLarge { limit } => write!(f, "This view exceeds its {} KiB limit. Use Text diff for large files, or Git locally for patches over 16 MiB.", limit / 1024),
            Self::InvalidText => write!(f, "This file is not UTF-8 text."),
            Self::Process { program, message } => write!(f, "{program} failed: {message}"),
            Self::InvalidSemantic(message) => write!(f, "SemanticDiff returned an invalid result: {message}"),
            Self::Storage(message) => write!(f, "Diff cache failed: {message}"),
            Self::UnexpectedArtifact => write!(f, "The diff service returned an unexpected view."),
        }
    }
}
impl std::error::Error for DiffError {}
