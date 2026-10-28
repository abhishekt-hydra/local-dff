//! Complete, short-lived GitHub topology metadata. Never substitute an empty
//! graph for a discovery failure or trust the historical capped-array cache.
use crate::{
    adapters, github_pr_cache_dir, parse_github_pr_url, read_json_cache, write_json_cache,
    ApiError, PullRequestInfo,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

pub(crate) const QUERY: &str = r#"query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, states: OPEN, after: $endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { number title url state baseRefName baseRefOid headRefName headRefOid isDraft isCrossRepository author { login } updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}"#;
const VERSION: u32 = 1;
const TTL: u64 = 60;

#[derive(Deserialize, Serialize)]
struct Cache {
    version: u32,
    repository: String,
    complete: bool,
    fetched_at: u64,
    pulls: Vec<PullRequestInfo>,
}
#[derive(Deserialize)]
struct Page {
    data: Data,
    errors: Option<Value>,
}
#[derive(Deserialize)]
struct Data {
    repository: Option<Repository>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    pull_requests: Connection,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    nodes: Vec<Value>,
    total_count: usize,
    page_info: PageInfo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

fn failure(message: impl std::fmt::Display) -> ApiError {
    ApiError { status: axum::http::StatusCode::SERVICE_UNAVAILABLE, message: format!("GitHub stack discovery failed: {message}. Retry opening this PR or refresh the PR list; no standalone comparison was substituted.") }
}
fn canonical(repository: &str) -> Result<String, ApiError> {
    // Reuse the same validated owner/name boundary as the filesystem cache.
    github_pr_cache_dir(Path::new(""), repository)?;
    Ok(repository.to_ascii_lowercase())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn validate_pull(pull: &PullRequestInfo, repository: &str) -> bool {
    let valid_oid = |value: &str| {
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    let reference = parse_github_pr_url(&pull.url).ok();
    pull.number > 0
        && !pull.base_ref_name.is_empty()
        && !pull.head_ref_name.is_empty()
        && valid_oid(&pull.base_ref_oid)
        && valid_oid(&pull.head_ref_oid)
        && reference.is_some_and(|reference| {
            reference.number == pull.number && reference.repo.eq_ignore_ascii_case(repository)
        })
}
fn valid_cache(cache: &Cache, repository: &str, time: u64) -> bool {
    let mut numbers = HashSet::new();
    cache.version == VERSION
        && cache.complete
        && cache.repository == repository
        && time
            .checked_sub(cache.fetched_at)
            .is_some_and(|age| age < TTL)
        && cache.pulls.iter().all(|pull| {
            pull.state == "OPEN" && validate_pull(pull, repository) && numbers.insert(pull.number)
        })
}

/// `gh --paginate --slurp` must end with a terminal page. Check the complete
/// connection, including totalCount, so partial GraphQL successes never cache.
fn parse_pages(bytes: &[u8], repository: &str) -> Result<Vec<PullRequestInfo>, ApiError> {
    let pages: Vec<Page> =
        serde_json::from_slice(bytes).map_err(|_| failure("invalid paginated response"))?;
    if pages.is_empty() {
        return Err(failure("missing pagination pages"));
    }
    let page_count = pages.len();
    let mut total = None;
    let mut cursors = HashSet::new();
    let mut pulls: BTreeMap<u64, PullRequestInfo> = BTreeMap::new();
    for (index, page) in pages.into_iter().enumerate() {
        if page.errors.is_some_and(|errors| {
            !errors.is_null() && errors.as_array().is_none_or(|errors| !errors.is_empty())
        }) {
            return Err(failure("GitHub returned GraphQL errors"));
        }
        let connection = page
            .data
            .repository
            .ok_or_else(|| failure("repository is missing or inaccessible"))?
            .pull_requests;
        if total
            .replace(connection.total_count)
            .is_some_and(|count| count != connection.total_count)
        {
            return Err(failure("open PR count changed during pagination"));
        }
        let more = index + 1 < page_count;
        if connection.nodes.len() > 100
            || connection.page_info.has_next_page != more
            || (more && connection.nodes.is_empty())
        {
            return Err(failure("incomplete pagination"));
        }
        if let Some(cursor) = connection
            .page_info
            .end_cursor
            .filter(|cursor| !cursor.is_empty())
        {
            if !cursors.insert(cursor) {
                return Err(failure("repeated pagination cursor"));
            }
        } else if more {
            return Err(failure("missing pagination cursor"));
        }
        for node in connection.nodes {
            // Several old CLI fields have serde defaults for backwards
            // compatibility. They must actually exist in this new contract.
            if crate::OPEN_PR_FIELDS
                .split(',')
                .any(|field| node.get(field).is_none())
            {
                return Err(failure("incomplete PR metadata"));
            }
            let pull: PullRequestInfo =
                serde_json::from_value(node).map_err(|_| failure("invalid PR metadata"))?;
            if pull.state != "OPEN" || !validate_pull(&pull, repository) {
                return Err(failure("unexpected repository, state, or PR revision"));
            }
            if let Some(previous) = pulls.get(&pull.number) {
                if serde_json::to_value(previous).ok() != serde_json::to_value(&pull).ok() {
                    return Err(failure("PR metadata changed during pagination"));
                }
            }
            pulls.insert(pull.number, pull);
        }
    }
    if total != Some(pulls.len()) {
        return Err(failure("pagination did not include every open PR"));
    }
    Ok(pulls.into_values().collect())
}

fn command(repo: &Path, repository: &str) -> Result<Command, ApiError> {
    let repository = canonical(repository)?;
    let (owner, name) = repository.split_once('/').unwrap();
    let mut command = Command::new("gh");
    command.current_dir(repo).args([
        "api",
        "--hostname",
        "github.com",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
        "-f",
        &format!("query={QUERY}"),
    ]);
    Ok(command)
}

pub(crate) async fn open(
    cache_dir: &Path,
    repo: &Path,
    repository: &str,
    refresh: bool,
) -> Result<Vec<PullRequestInfo>, ApiError> {
    let repository = canonical(repository)?;
    let path = github_pr_cache_dir(cache_dir, &repository)?.join("open.json");
    if !refresh {
        if let Some(cache) =
            read_json_cache::<Cache>(&path).filter(|cache| valid_cache(cache, &repository, now()))
        {
            return Ok(cache.pulls);
        }
    }
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        adapters::output(
            command(repo, &repository)?,
            "GitHub CLI",
            None,
            16 * 1024 * 1024,
        ),
    )
    .await
    .map_err(|_| failure("metadata pagination timed out"))?
    .map_err(failure)?;
    let pulls = parse_pages(&output, &repository)?;
    write_json_cache(
        &path,
        &Cache {
            version: VERSION,
            repository,
            complete: true,
            fetched_at: now(),
            pulls: pulls.clone(),
        },
    )?;
    Ok(pulls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn pull(number: u64) -> Value {
        let mut pull = crate::test_support::pull(number, "a", "b");
        pull.base_ref_oid = "a".repeat(40);
        pull.head_ref_oid = "b".repeat(40);
        serde_json::to_value(pull).unwrap()
    }
    fn page(nodes: Vec<Value>, total: usize, more: bool, cursor: Option<&str>) -> Value {
        json!({"data":{"repository":{"pullRequests":{"nodes":nodes,"totalCount":total,"pageInfo":{"hasNextPage":more,"endCursor":cursor}}}}})
    }
    fn parse(pages: Vec<Value>) -> Result<Vec<PullRequestInfo>, ApiError> {
        parse_pages(&serde_json::to_vec(&pages).unwrap(), "owner/repo")
    }
    #[test]
    fn complete_pagination_exceeds_old_cap_and_deduplicates_identical_nodes() {
        let pages = vec![
            page((1..=100).map(pull).collect(), 182, true, Some("page-1")),
            page((100..=182).map(pull).collect(), 182, false, Some("page-2")),
        ];
        let pulls = parse(pages).unwrap();
        assert_eq!(pulls.len(), 182);
        assert_eq!(pulls[181].number, 182);
        assert!(parse(vec![page(vec![], 0, false, None)])
            .unwrap()
            .is_empty());
    }
    #[test]
    fn incomplete_errors_wrong_repo_and_invalid_metadata_fail_explicitly() {
        let mut wrong_repo = pull(1);
        wrong_repo["url"] = json!("https://github.com/other/repo/pull/1");
        let mut missing = pull(1);
        missing.as_object_mut().unwrap().remove("isCrossRepository");
        let mut errors = page(vec![pull(1)], 1, false, Some("end"));
        errors["errors"] = json!([{"message":"partial response"}]);
        for pages in [
            vec![],
            vec![page(vec![pull(1)], 2, true, Some("more"))],
            vec![page(vec![pull(1)], 2, false, Some("end"))],
            vec![page(vec![wrong_repo], 1, false, None)],
            vec![page(vec![missing], 1, false, None)],
            vec![errors],
            vec![
                page(vec![pull(1)], 2, true, Some("same")),
                page(vec![pull(2)], 2, false, Some("same")),
            ],
        ] {
            let error = parse(pages).err().unwrap();
            assert_eq!(error.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
            assert!(error.message.contains("Retry"));
        }
    }
    #[test]
    fn complete_cache_contract_expires_and_rejects_legacy_partial_or_future_data() {
        let mut cache = Cache {
            version: VERSION,
            repository: "owner/repo".into(),
            complete: true,
            fetched_at: 100,
            pulls: vec![serde_json::from_value(pull(1)).unwrap()],
        };
        assert!(valid_cache(&cache, "owner/repo", 159));
        assert!(!valid_cache(&cache, "owner/repo", 160));
        assert!(!valid_cache(&cache, "owner/repo", 99));
        assert!(!valid_cache(&cache, "other/repo", 100));
        assert!(serde_json::from_value::<Cache>(json!([pull(1)])).is_err());
        cache.complete = false;
        assert!(!valid_cache(&cache, "owner/repo", 100));
        cache.complete = true;
        cache.version += 1;
        assert!(!valid_cache(&cache, "owner/repo", 100));
    }
    #[tokio::test]
    async fn valid_complete_disk_cache_is_shared_without_running_gh() {
        let repo = crate::test_support::Repo::new();
        let path = github_pr_cache_dir(&repo.0, "owner/repo")
            .unwrap()
            .join("open.json");
        write_json_cache(
            &path,
            &Cache {
                version: VERSION,
                repository: "owner/repo".into(),
                complete: true,
                fetched_at: now(),
                pulls: vec![serde_json::from_value(pull(1)).unwrap()],
            },
        )
        .unwrap();
        let pulls = open(&repo.0, &repo.0, "Owner/Repo", false).await.unwrap();
        assert_eq!(pulls[0].number, 1);
        write_json_cache(&path, &vec![pull(1)]).unwrap();
        assert!(read_json_cache::<Cache>(&path).is_none());
    }

    #[tokio::test]
    #[ignore = "requires GitHub authentication; metadata-only, no clone"]
    async fn live_metadata_contract() {
        let repo = crate::test_support::Repo::new();
        let pulls = open(&repo.0, &repo.0, "hydra-db/hydradb-application", true)
            .await
            .unwrap_or_else(|error| panic!("{}", error.message));
        println!("Complete live metadata: {} open PRs", pulls.len());
        if let Some(selected) = pulls.iter().find(|pull| pull.number == 2480) {
            let members = crate::stacks::stack_members(&pulls, selected);
            println!(
                "#2480 discovered members: {:?}",
                members
                    .iter()
                    .map(|member| member.pull.number)
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn query_and_cli_contract_use_real_cursor_pagination_and_literal_variables() {
        assert!(QUERY.contains("$endCursor: String"));
        assert!(QUERY.contains("after: $endCursor"));
        assert!(QUERY.contains("pageInfo { hasNextPage endCursor }"));
        let command = command(Path::new("."), "123/456").unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--paginate") && args.contains(&"--slurp"));
        assert!(args.windows(2).any(|pair| pair == ["-f", "owner=123"]));
        assert!(!args.contains(&"--limit"));
        assert!(super::command(Path::new("."), "../bad/repo").is_err());
    }
}
