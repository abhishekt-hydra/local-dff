//! Commit-by-commit review: list the first-parent commits of a comparison and
//! resolve one of them to its own (base, target) pair.
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::ApiError;

/// Newest commits kept when a range is unexpectedly long (for example a base
/// that is not an ancestor of the target).
const COMMIT_LIMIT: usize = 1000;
const RECORD: char = '\x1e';
const FIELD: char = '\x1f';

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CommitInfo {
    pub sha: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub files_changed: usize,
}

#[derive(Clone, Debug, Default)]
pub struct CommitLog {
    /// Oldest first, matching GitHub's Commits tab.
    pub commits: Vec<CommitInfo>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScopeMode {
    /// The commit against its first parent.
    Commit,
    /// The comparison base through this commit.
    Cumulative,
}

/// List `base..target` along the first-parent chain, so a branch that merged
/// its base back in lists the merge rather than every commit it brought along.
/// File counts come from `--name-only`, which reads trees only: the GitHub
/// cache is a blobless clone, and line stats would fetch every blob.
pub async fn commit_log(repo: &Path, base: &str, target: &str) -> Result<CommitLog, ApiError> {
    let range = format!("{base}..{target}");
    let max_count = format!("--max-count={}", COMMIT_LIMIT + 1);
    let output = Command::new("git")
        .current_dir(repo)
        .args([
            "log",
            "--first-parent",
            "--diff-merges=first-parent",
            "--no-renames",
            "--name-only",
            &max_count,
            "--format=%x1e%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s",
            &range,
            "--",
        ])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not list commits: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::bad_request(format!(
            "Could not list commits in `{range}`: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let mut commits = parse_commit_log(&String::from_utf8_lossy(&output.stdout));
    let truncated = commits.len() > COMMIT_LIMIT;
    commits.truncate(COMMIT_LIMIT);
    commits.reverse();
    Ok(CommitLog { commits, truncated })
}

/// Parse `git log` records as emitted by [`commit_log`], newest first.
fn parse_commit_log(output: &str) -> Vec<CommitInfo> {
    output
        .split(RECORD)
        .filter_map(|record| {
            let mut lines = record.lines();
            let mut fields = lines.next()?.splitn(6, FIELD);
            let sha = fields.next().filter(|sha| !sha.is_empty())?.to_owned();
            let short = fields.next()?.to_owned();
            let parents = fields
                .next()?
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            let author = fields.next()?.to_owned();
            let date = fields.next()?.to_owned();
            let subject = fields.next().unwrap_or_default().to_owned();
            Some(CommitInfo {
                sha,
                short,
                parents,
                author,
                date,
                subject,
                files_changed: lines.filter(|line| !line.is_empty()).count(),
            })
        })
        .collect()
}

/// The base revision a scoped comparison diffs `commit` against. A root commit
/// has no parent, so it is compared with the empty tree.
pub async fn scope_base(
    repo: &Path,
    commit: &CommitInfo,
    mode: ScopeMode,
    range_base: &str,
) -> Result<String, ApiError> {
    match (mode, commit.parents.first()) {
        (ScopeMode::Cumulative, _) => Ok(range_base.to_owned()),
        (ScopeMode::Commit, Some(parent)) => Ok(parent.clone()),
        (ScopeMode::Commit, None) => empty_tree(repo).await,
    }
}

/// Ask Git rather than hard-coding the SHA-1 empty tree, so SHA-256
/// repositories work too.
async fn empty_tree(repo: &Path) -> Result<String, ApiError> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(["hash-object", "-t", "tree", "/dev/null"])
        .output()
        .await
        .map_err(|error| ApiError::internal(format!("Could not run git: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::internal(format!(
            "Could not resolve the empty tree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Command as StdCommand};

    fn record(sha: &str, parents: &str, subject: &str, files: &[&str]) -> String {
        let mut record = format!(
            "{RECORD}{sha}{FIELD}{}{FIELD}{parents}{FIELD}A U Thor{FIELD}2026-09-25T10:00:00+00:00{FIELD}{subject}\n",
            &sha[..7]
        );
        if !files.is_empty() {
            record.push('\n');
            for file in files {
                record.push_str(file);
                record.push('\n');
            }
        }
        record
    }

    #[test]
    fn parses_root_merge_and_empty_commits() {
        let output = [
            record(
                "c".repeat(40).as_str(),
                "bbbbbbb aaaaaaa",
                "Merge branch 'side'",
                &["b"],
            ),
            record("b".repeat(40).as_str(), "aaaaaaa", "empty", &[]),
            record(
                "a".repeat(40).as_str(),
                "",
                "root \x1f with separator",
                &["a", "dir/c"],
            ),
        ]
        .concat();
        let commits = parse_commit_log(&output);
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].parents, ["bbbbbbb", "aaaaaaa"]);
        assert_eq!(commits[0].files_changed, 1);
        assert_eq!(commits[1].files_changed, 0);
        assert!(commits[2].parents.is_empty());
        assert_eq!(commits[2].short, "aaaaaaa");
        assert_eq!(commits[2].subject, "root \x1f with separator");
        assert_eq!(commits[2].files_changed, 2);
    }

    struct TempRepo(PathBuf);

    impl TempRepo {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("local-diffe-commits-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let repo = Self(path);
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "user.name", "Test"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let output = StdCommand::new("git")
                .current_dir(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        }

        fn commit_file(&self, name: &str, message: &str) -> String {
            std::fs::write(self.0.join(name), message).unwrap();
            self.git(&["add", name]);
            self.git(&["commit", "-qm", message]);
            self.git(&["rev-parse", "HEAD"])
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn lists_first_parent_commits_oldest_first() {
        let repo = TempRepo::new();
        let root = repo.commit_file("a", "root");
        repo.git(&["commit", "-q", "--allow-empty", "-m", "empty"]);
        repo.git(&["checkout", "-qb", "side"]);
        repo.commit_file("b", "side one");
        repo.commit_file("c", "side two");
        repo.git(&["checkout", "-q", "main"]);
        repo.commit_file("d", "main work");
        repo.git(&["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
        let head = repo.git(&["rev-parse", "HEAD"]);

        let log = commit_log(&repo.0, &root, &head).await.unwrap();
        let subjects = log
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>();
        assert_eq!(subjects, ["empty", "main work", "merge side"]);
        assert!(!log.truncated);
        assert_eq!(log.commits[0].files_changed, 0);
        assert_eq!(log.commits[1].files_changed, 1);
        // The merge is diffed against its first parent: both side files.
        assert_eq!(log.commits[2].files_changed, 2);
        assert_eq!(log.commits[2].parents.len(), 2);

        let merge = &log.commits[2];
        assert_eq!(
            scope_base(&repo.0, merge, ScopeMode::Commit, &root)
                .await
                .unwrap(),
            log.commits[1].sha
        );
        assert_eq!(
            scope_base(&repo.0, merge, ScopeMode::Cumulative, &root)
                .await
                .unwrap(),
            root
        );
    }

    #[tokio::test]
    async fn root_commit_scopes_against_the_empty_tree() {
        let repo = TempRepo::new();
        let root = repo.commit_file("a", "root");
        // A base from unrelated history leaves the target's root in range.
        repo.git(&["checkout", "-q", "--orphan", "other"]);
        let other = repo.commit_file("z", "unrelated");
        let log = commit_log(&repo.0, &other, &root).await.unwrap();
        assert_eq!(log.commits.len(), 1);
        assert!(log.commits[0].parents.is_empty());
        let empty_tree = repo.git(&["hash-object", "-t", "tree", "/dev/null"]);
        assert_eq!(
            scope_base(&repo.0, &log.commits[0], ScopeMode::Commit, &other)
                .await
                .unwrap(),
            empty_tree
        );
    }
}
