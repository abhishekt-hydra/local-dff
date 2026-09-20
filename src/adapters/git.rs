use super::process::output;
use crate::{
    domain::{DiffError, DiffInput, FileContents},
    ports::{DiffSource, Task},
};
use tokio::process::Command;

pub struct GitDiffSource;
const PATCH_LIMIT: usize = 16 * 1024 * 1024;
const CONTENT_LIMIT: usize = 1024 * 1024;

impl DiffSource for GitDiffSource {
    fn text_diff(&self, input: DiffInput) -> Task<String> {
        Box::pin(async move {
            let mut command = Command::new("git");
            command.current_dir(&input.repo).args([
                "--literal-pathspecs",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--unified=3",
                "--no-renames",
                &input.base,
                &input.target,
                "--",
            ]);
            for path in [input.file.old_path.as_ref(), input.file.new_path.as_ref()]
                .into_iter()
                .flatten()
            {
                command.arg(path);
            }
            let bytes = output(command, "Git", None, PATCH_LIMIT).await?;
            String::from_utf8(bytes).map_err(|_| DiffError::InvalidText)
        })
    }

    fn contents(&self, input: DiffInput) -> Task<FileContents> {
        Box::pin(async move {
            let read = |revision: String, path: Option<String>| {
                let repo = input.repo.clone();
                async move {
                    let Some(path) = path else {
                        return Ok(String::new());
                    };
                    let mut command = Command::new("git");
                    command
                        .current_dir(repo)
                        .args(["show", &format!("{revision}:{path}")]);
                    let bytes = output(command, "Git", None, CONTENT_LIMIT).await?;
                    String::from_utf8(bytes).map_err(|_| DiffError::InvalidText)
                }
            };
            let (old, new) = tokio::try_join!(
                read(input.base, input.file.old_path),
                read(input.target, input.file.new_path)
            )?;
            if old.len() + new.len() > CONTENT_LIMIT {
                return Err(DiffError::TooLarge {
                    limit: CONTENT_LIMIT,
                });
            }
            Ok(FileContents { old, new })
        })
    }
}
