use crate::domain::{DiffInput, FileEntry};

pub struct Repo(pub std::path::PathBuf);
impl Repo {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("local-diffe-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        let repo = Self(path);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }
    pub fn git(&self, args: &[&str]) -> String {
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
    pub fn write(&self, path: &str, contents: &str) -> String {
        std::fs::write(self.0.join(path), contents).unwrap();
        self.commit()
    }
    pub fn commit(&self) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", "test snapshot"]);
        self.git(&["rev-parse", "HEAD"])
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn pull(number: u64, base: &str, head: &str) -> crate::PullRequestInfo {
    crate::PullRequestInfo {
        number,
        title: format!("PR {number}"),
        url: format!("https://github.com/Owner/Repo/pull/{number}"),
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

pub async fn stack_fixture() -> (Repo, std::sync::Arc<crate::stacks::Stack>) {
    let repo = Repo::new();
    repo.write("shared.go", "package p\nfunc A() { base() }\n");
    repo.git(&["checkout", "-qb", "one"]);
    let first = repo.write("shared.go", "package p\nfunc A() { first() }\n");
    repo.git(&["update-ref", "refs/pull/1/head", &first]);
    repo.git(&["checkout", "-qb", "two"]);
    std::fs::write(repo.0.join("shared.go"), "package p\nfunc A() { base() }\n").unwrap();
    let second = repo.write("second.go", "package p\nfunc Second() {}\n");
    repo.git(&["update-ref", "refs/pull/2/head", &second]);
    repo.git(&["checkout", "-q", "one"]);
    repo.git(&["checkout", "-qb", "three"]);
    let third = repo.write("third.go", "package p\nfunc Third() {}\n");
    repo.git(&["update-ref", "refs/pull/3/head", &third]);
    repo.git(&["remote", "add", "origin", repo.0.to_str().unwrap()]);
    let pulls = [
        pull(1, "main", "one"),
        pull(2, "one", "two"),
        pull(3, "one", "three"),
    ];
    let members = crate::stacks::stack_members(&pulls, &pulls[1]);
    let stack = std::sync::Arc::new(crate::stacks::resolve(&repo.0, members).await.unwrap());
    (repo, stack)
}

pub fn state() -> crate::AppState {
    struct Reader;
    impl crate::ports::DiffReader for Reader {
        fn load(
            &self,
            _: crate::domain::DiffInput,
            _: crate::domain::DiffKind,
        ) -> crate::ports::Task<std::sync::Arc<crate::domain::DiffArtifact>> {
            Box::pin(async { Err(crate::domain::DiffError::UnexpectedArtifact) })
        }
        fn prefetch(&self, _: crate::domain::DiffInput) -> crate::ports::Task<()> {
            Box::pin(async { Ok(()) })
        }
    }
    crate::AppState {
        diffs: std::sync::Arc::new(Reader),
        cache_dir: std::env::temp_dir(),
        github_cache_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        sessions: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        warmup: crate::warmup::Warmup::default(),
        reviews: std::sync::Arc::new(std::sync::Mutex::new(crate::review::Snapshots::default())),
    }
}

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
            change_kind: None,
        },
    }
}
