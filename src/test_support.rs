use crate::domain::{DiffInput, FileEntry};

pub fn input() -> DiffInput {
    DiffInput {
        repo: "/test/repo".into(),
        base: "base-commit".into(),
        target: "target-commit".into(),
        file: FileEntry {
            old_path: Some("file.rs".into()),
            new_path: Some("file.rs".into()),
            display_path: "file.rs".into(),
            renderable: true,
        },
    }
}
