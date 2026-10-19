//! Stacked pull requests: find the open PRs a PR is stacked with, and resolve
//! each of them to the (base, head) pairs it can be reviewed with.
//!
//! A PR is stacked on another when its base branch is that PR's head branch.
//! Only same-repository PRs take part: fork branch names are not unique.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};

use crate::{git_command, git_commit, git_merge_base, ApiError, PullRequestInfo};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StackMode {
    /// The PR's own changes, compared with its parent PR's head.
    Pr,
    /// Everything from the stack's trunk through this PR.
    Cumulative,
}

#[derive(Clone, Debug, Serialize)]
pub struct StackMember {
    pub pull: PullRequestInfo,
    /// The PR this one is stacked on; `None` for a PR based on the trunk.
    pub parent: Option<u64>,
    /// Distance from the bottom of the stack, for indenting branches.
    pub depth: usize,
}

#[derive(Debug)]
pub struct ResolvedMember {
    pub member: StackMember,
    pub head: String,
    /// Merge-base with the parent PR's head (or the trunk for the bottom PR).
    pub base: String,
    /// Merge-base with the trunk.
    pub cumulative_base: String,
}

#[derive(Debug)]
pub struct Stack {
    /// The branch the bottom PR targets, usually `main`.
    pub trunk: String,
    /// Depth-first from the bottom PR, children in PR-number order.
    pub members: Vec<ResolvedMember>,
}

impl Stack {
    pub fn position(&self, number: u64) -> Option<usize> {
        self.members
            .iter()
            .position(|member| member.member.pull.number == number)
    }
}

/// The stack containing `pull`, bottom first; empty when `pull` is not stacked
/// with any other open PR. `pull` is the freshest copy of that PR and replaces
/// its entry in the (possibly older) open-PR list.
pub fn stack_members(open: &[PullRequestInfo], pull: &PullRequestInfo) -> Vec<StackMember> {
    if pull.is_cross_repository || !pull.state.eq_ignore_ascii_case("open") {
        return Vec::new();
    }
    let pulls = open
        .iter()
        .filter(|candidate| candidate.number != pull.number && !candidate.is_cross_repository)
        .chain(std::iter::once(pull))
        .collect::<Vec<_>>();
    let mut by_head = HashMap::<&str, Vec<&PullRequestInfo>>::new();
    for candidate in &pulls {
        by_head
            .entry(candidate.head_ref_name.as_str())
            .or_default()
            .push(candidate);
    }
    // Several open PRs can share one head branch; the parent is then ambiguous
    // and the walk stops rather than guessing.
    let parent_of = |child: &PullRequestInfo| match by_head
        .get(child.base_ref_name.as_str())
        .map(Vec::as_slice)
    {
        Some([parent]) if parent.number != child.number => Some(*parent),
        _ => None,
    };

    let mut bottom = pull;
    let mut seen = HashSet::from([pull.number]);
    while let Some(parent) = parent_of(bottom) {
        if !seen.insert(parent.number) {
            break;
        }
        bottom = parent;
    }

    let mut members = Vec::new();
    let mut seen = HashSet::new();
    let mut pending = vec![(bottom, None, 0)];
    while let Some((current, parent, depth)) = pending.pop() {
        if !seen.insert(current.number) {
            continue;
        }
        members.push(StackMember {
            pull: current.clone(),
            parent,
            depth,
        });
        let mut children = pulls
            .iter()
            .copied()
            .filter(|child| {
                child.number != current.number
                    && parent_of(child).map(|found| found.number) == Some(current.number)
            })
            .collect::<Vec<_>>();
        // Reverse so the lowest-numbered child is popped (visited) first.
        children.sort_by_key(|child| std::cmp::Reverse(child.number));
        pending.extend(
            children
                .into_iter()
                .map(|child| (child, Some(current.number), depth + 1)),
        );
    }
    if members.len() < 2 {
        members.clear();
    }
    members
}

/// Fetch every member's current head and the trunk in one round trip, then
/// compute each member's bases. Parent heads are read from the fresh fetch, not
/// from cached `baseRefOid`s, which go stale whenever a parent is pushed.
pub async fn resolve(repo: &PathBuf, members: Vec<StackMember>) -> Result<Stack, ApiError> {
    let trunk = members
        .first()
        .map(|member| member.pull.base_ref_name.clone())
        .ok_or_else(|| ApiError::internal("A stack needs at least one pull request."))?;
    let trunk_ref = format!("refs/local-diffe/stack-trunk/{trunk}");
    let mut refspecs = vec![format!("+refs/heads/{trunk}:{trunk_ref}")];
    refspecs.extend(members.iter().map(|member| {
        let number = member.pull.number;
        format!("+refs/pull/{number}/head:refs/local-diffe/pr/{number}")
    }));
    let mut args = vec!["fetch", "--no-tags", "origin"];
    args.extend(refspecs.iter().map(String::as_str));
    git_command(repo, &args).await?;

    let trunk_tip = git_commit(repo, &trunk_ref).await?;
    let mut heads = HashMap::<u64, String>::new();
    let mut resolved = Vec::with_capacity(members.len());
    for member in members {
        let number = member.pull.number;
        let head = git_commit(repo, &format!("refs/local-diffe/pr/{number}")).await?;
        let cumulative_base = git_merge_base(repo, &trunk_tip, &head).await?;
        let base = match member.parent.and_then(|parent| heads.get(&parent)) {
            Some(parent_head) => git_merge_base(repo, parent_head, &head).await?,
            None => cumulative_base.clone(),
        };
        heads.insert(number, head.clone());
        resolved.push(ResolvedMember {
            member,
            head,
            base,
            cumulative_base,
        });
    }
    Ok(Stack {
        trunk,
        members: resolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64, base: &str, head: &str) -> PullRequestInfo {
        PullRequestInfo {
            number,
            title: format!("PR {number}"),
            url: String::new(),
            state: "OPEN".into(),
            base_ref_name: base.into(),
            base_ref_oid: String::new(),
            head_ref_name: head.into(),
            head_ref_oid: String::new(),
            is_draft: false,
            is_cross_repository: false,
            author: None,
            updated_at: String::new(),
        }
    }

    fn numbers(members: &[StackMember]) -> Vec<(u64, Option<u64>, usize)> {
        members
            .iter()
            .map(|member| (member.pull.number, member.parent, member.depth))
            .collect()
    }

    #[test]
    fn walks_to_the_bottom_and_lists_the_whole_tree_depth_first() {
        let open = [
            pr(1, "main", "a"),
            pr(2, "a", "b"),
            pr(3, "b", "c"),
            pr(5, "a", "e"),
            pr(4, "main", "unrelated"),
        ];
        let members = stack_members(&open, &open[2]);
        assert_eq!(
            numbers(&members),
            [
                (1, None, 0),
                (2, Some(1), 1),
                (3, Some(2), 2),
                (5, Some(1), 1)
            ]
        );
    }

    #[test]
    fn standalone_closed_and_fork_prs_have_no_stack() {
        let open = [pr(1, "main", "a"), pr(2, "main", "b")];
        assert!(stack_members(&open, &open[0]).is_empty());

        let mut merged = pr(3, "a", "c");
        merged.state = "MERGED".into();
        assert!(stack_members(&open, &merged).is_empty());

        let mut fork = pr(4, "main", "a");
        fork.is_cross_repository = true;
        let open = [pr(1, "main", "x"), fork.clone(), pr(5, "a", "y")];
        assert!(stack_members(&open, &open[2]).is_empty());
    }

    #[test]
    fn fresher_pull_replaces_the_listed_copy_and_ambiguous_parents_stop() {
        // The list still shows #2 on `main`; the fresh copy says it was retargeted.
        let open = [pr(1, "main", "a"), pr(2, "main", "b")];
        let fresh = pr(2, "a", "b");
        assert_eq!(
            numbers(&stack_members(&open, &fresh)),
            [(1, None, 0), (2, Some(1), 1)]
        );

        let open = [pr(1, "main", "a"), pr(2, "dev", "a"), pr(3, "a", "c")];
        assert!(stack_members(&open, &open[2]).is_empty());
    }

    #[test]
    fn cycles_terminate() {
        let open = [pr(1, "b", "a"), pr(2, "a", "b")];
        let members = stack_members(&open, &open[0]);
        assert_eq!(members.len(), 2);
    }

    struct TempRepo(PathBuf);

    impl TempRepo {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("local-diffe-stack-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
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

        fn commit_file(&self, name: &str, contents: &str) -> String {
            std::fs::write(self.0.join(name), contents).unwrap();
            self.git(&["add", name]);
            self.git(&["commit", "-qm", contents]);
            self.git(&["rev-parse", "HEAD"])
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn bases_follow_the_parents_current_head() {
        // `origin` stands in for GitHub, publishing PR heads as refs/pull/N/head.
        let origin = TempRepo::new("origin");
        origin.git(&["init", "-q", "-b", "main"]);
        origin.git(&["config", "user.email", "test@example.com"]);
        origin.git(&["config", "user.name", "Test"]);
        let trunk = origin.commit_file("base", "trunk");
        origin.git(&["checkout", "-qb", "a"]);
        origin.commit_file("a", "first pr");
        origin.git(&["checkout", "-qb", "b"]);
        let second = origin.commit_file("b", "second pr");
        // The parent is pushed again after the child branched off it.
        origin.git(&["checkout", "-q", "a"]);
        let first = origin.commit_file("a2", "first pr follow-up");
        origin.git(&["update-ref", "refs/pull/1/head", &first]);
        origin.git(&["update-ref", "refs/pull/2/head", &second]);
        origin.git(&["checkout", "-q", "main"]);
        let moved_trunk = origin.commit_file("later", "trunk moved");

        let clone = TempRepo::new("clone");
        clone.git(&["init", "-q"]);
        clone.git(&["remote", "add", "origin", origin.0.to_str().unwrap()]);

        let members = stack_members(&[pr(1, "main", "a")], &pr(2, "a", "b"));
        let stack = resolve(&clone.0, members).await.unwrap();
        assert_eq!(stack.trunk, "main");
        let [bottom, top] = stack.members.as_slice() else {
            panic!("expected two members");
        };
        assert_eq!(bottom.head, first);
        assert_eq!(bottom.base, trunk);
        assert_eq!(bottom.cumulative_base, trunk);
        assert_ne!(trunk, moved_trunk);
        assert_eq!(top.head, second);
        // Only #2's own commit: the merge-base with #1's head, not `main`.
        assert_eq!(top.base, clone.git(&["rev-parse", &format!("{second}~1")]));
        assert_eq!(top.cumulative_base, trunk);
    }
}
