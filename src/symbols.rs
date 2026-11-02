//! Deliberately narrow Go declaration pilot: exact same-file qualified names,
//! never cross-file identities. Unknown syntax falls back to file history.
use crate::{
    adapters::GitDiffSource, domain::DiffInput, ports::DiffSource, stacks::StackMode, ApiError,
    AppState,
};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

const POLICY: &str = "go-functions-v1: exact same-path function/method name and receiver type; lexical comments/strings/braces; no generics, cross-file moves, renames, splits or stable symbol IDs; edited existing declarations with any addition/removal fall back as possible split/merge; ambiguous matches never inherit review status; hashes are noncryptographic content cues only";
#[derive(Deserialize)]
pub struct Request {
    id: String,
    number: u64,
    path: String,
}
#[derive(Debug, Serialize)]
pub struct Response {
    state: &'static str,
    policy: &'static str,
    symbols: Vec<Symbol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Symbol {
    key: String,
    name: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_source: Option<String>,
}
fn unsupported(message: impl Into<String>) -> Response {
    Response {
        state: "unsupported",
        policy: POLICY,
        symbols: vec![],
        message: Some(message.into()),
    }
}

pub async fn stack_symbols(
    State(state): State<AppState>,
    Json(request): Json<Request>,
) -> Result<Json<Response>, ApiError> {
    let session = crate::review::session(&state, &request.id)?;
    let stack = session
        .stack
        .ok_or_else(|| ApiError::bad_request("This comparison is not part of a PR stack."))?;
    let position = stack
        .position(request.number)
        .ok_or_else(|| ApiError::bad_request("That pull request is not part of this stack."))?;
    if !request.path.ends_with(".go") {
        return Ok(Json(unsupported(
            "Only same-file Go functions and methods are supported.",
        )));
    }
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let comparison = stack.comparison(&session.repo, request.number, StackMode::Pr).await?;
        let file = comparison.files.iter().find(|file| file.display_path == request.path || file.old_path.as_deref() == Some(&request.path) || file.new_path.as_deref() == Some(&request.path))
            .ok_or_else(|| ApiError::bad_request("That file is not part of this PR comparison."))?;
        if !file.renderable { return Ok(Json(unsupported("This file has no supported text diff; use file history."))); }
        if file.change_kind.as_deref() == Some("copied") || matches!((&file.old_path, &file.new_path), (Some(old), Some(new)) if old != new) {
            return Ok(Json(unsupported("Renamed/copied files require file history; the symbol pilot does not infer continuity.")));
        }
        let member = &stack.members[position];
        let contents = GitDiffSource.contents(DiffInput { repo: session.repo, base: member.base.clone(), target: member.head.clone(), file: file.clone() }).await;
        Ok(Json(match contents {
            Ok(contents) => compare(&contents.old, &contents.new),
            Err(error) => unsupported(format!("Symbol contents unavailable: {error}")),
        }))
    }).await;
    match result {
        Ok(result) => result,
        Err(_) => Ok(Json(unsupported(
            "Symbol inspection timed out; use file history or retry.",
        ))),
    }
}

#[derive(Debug)]
struct Declaration<'a> {
    key: String,
    name: String,
    start: usize,
    end: usize,
    text: &'a str,
}
#[derive(Debug)]
struct Token<'a> {
    text: &'a str,
    start: usize,
    end: usize,
    line: usize,
    end_line: usize,
}

/// Comments and literals are consumed atomically, so braces/func inside either
/// cannot introduce declarations. Bounds are inherited from Git's 1 MiB reader.
fn tokens(source: &str) -> Result<Vec<Token<'_>>, &'static str> {
    let bytes = source.as_bytes();
    let (mut i, mut line) = (0, 1);
    let mut result = Vec::new();
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            if bytes[i] == b'\n' {
                line += 1;
            }
            i += 1;
            continue;
        }
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i..].starts_with(b"/*") {
            i += 2;
            while i < bytes.len() && !bytes[i..].starts_with(b"*/") {
                if bytes[i] == b'\n' {
                    line += 1;
                }
                i += 1;
            }
            if i == bytes.len() {
                return Err("Unterminated block comment.");
            }
            i += 2;
            continue;
        }
        let (start, start_line) = (i, line);
        let quote = bytes[i];
        if matches!(quote, b'\'' | b'"' | b'`') {
            i += 1;
            let mut closed = false;
            while i < bytes.len() {
                if bytes[i] == quote {
                    i += 1;
                    closed = true;
                    break;
                }
                if bytes[i] == b'\\' && quote != b'`' {
                    i += 1;
                    if i >= bytes.len() || bytes[i] == b'\n' {
                        return Err("Invalid quoted literal.");
                    }
                } else if bytes[i] == b'\n' {
                    if quote != b'`' {
                        return Err("Newline in quoted literal.");
                    }
                    line += 1;
                }
                i += 1;
            }
            if !closed {
                return Err("Unterminated literal.");
            }
        } else if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
        } else {
            if !bytes[i].is_ascii() {
                return Err("Unicode identifiers are outside this pilot's supported syntax.");
            }
            i += 1;
        }
        if result.len() == 100_000 {
            return Err("Go token count exceeds the 100,000-token pilot limit; use file history.");
        }
        result.push(Token {
            text: &source[start..i],
            start,
            end: i,
            line: start_line,
            end_line: line,
        });
    }
    Ok(result)
}
fn identifier(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}
fn closing(
    tokens: &[Token<'_>],
    start: usize,
    open: &str,
    close: &str,
) -> Result<usize, &'static str> {
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().skip(start) {
        if token.text == open {
            depth += 1;
        }
        if token.text == close {
            depth = depth.checked_sub(1).ok_or("Unbalanced delimiter.")?;
            if depth == 0 {
                return Ok(index);
            }
        }
    }
    Err("Unbalanced delimiter.")
}
fn declarations(source: &str) -> Result<Vec<Declaration<'_>>, &'static str> {
    let tokens = tokens(source)?;
    let (mut i, mut braces) = (0, 0usize);
    let mut declarations = Vec::new();
    while i < tokens.len() {
        let token = &tokens[i];
        if token.text == "{" {
            braces += 1;
        }
        if token.text == "}" {
            braces = braces.checked_sub(1).ok_or("Unbalanced Go braces.")?;
        }
        if token.text != "func" || braces != 0 {
            i += 1;
            continue;
        }
        let begin = i;
        i += 1;
        let mut receiver = None;
        if tokens.get(i).is_some_and(|token| token.text == "(") {
            let end = closing(&tokens, i, "(", ")")?;
            let parts = &tokens[i + 1..end];
            let type_name = match parts {
                [name] if identifier(name.text) => name.text.to_owned(),
                [star, name] if star.text == "*" && identifier(name.text) => {
                    format!("*{}", name.text)
                }
                [binding, name] if identifier(binding.text) && identifier(name.text) => {
                    name.text.to_owned()
                }
                [binding, star, name]
                    if identifier(binding.text) && star.text == "*" && identifier(name.text) =>
                {
                    format!("*{}", name.text)
                }
                _ => return Err("Generic or complex receivers are outside this pilot."),
            };
            receiver = Some(type_name);
            i = end + 1;
        }
        let name = tokens
            .get(i)
            .filter(|token| identifier(token.text))
            .ok_or("Anonymous top-level func expressions are outside this pilot.")?
            .text;
        if name == "_" {
            return Err("Blank-name functions have no matchable identity in this pilot.");
        }
        i += 1;
        if tokens.get(i).is_some_and(|token| token.text == "[") {
            return Err("Generic declarations are outside this pilot.");
        }
        if !tokens.get(i).is_some_and(|token| token.text == "(") {
            return Err("Cannot establish Go function signature.");
        }
        i = closing(&tokens, i, "(", ")")? + 1;
        // Reject signatures whose inline struct/interface body could be mistaken
        // for the function body, and bodyless assembler declarations.
        let mut parens = 0usize;
        while i < tokens.len() && !(tokens[i].text == "{" && parens == 0) {
            if matches!(tokens[i].text, "struct" | "interface" | "func" | ";") {
                return Err("Complex or bodyless signatures are outside this pilot.");
            }
            if tokens[i].text == "(" {
                parens += 1;
            }
            if tokens[i].text == ")" {
                parens = parens.checked_sub(1).ok_or("Invalid signature.")?;
            }
            // A new top-level declaration on the next line is not this body.
            if matches!(tokens[i].text, "type" | "var" | "const") {
                return Err("Bodyless declarations are outside this pilot.");
            }
            i += 1;
        }
        if i == tokens.len() {
            return Err("Bodyless function declaration.");
        }
        let end = closing(&tokens, i, "{", "}")?;
        let display = receiver
            .as_ref()
            .map(|value| format!("({value}).{name}"))
            .unwrap_or_else(|| name.to_owned());
        let key = receiver
            .map(|value| format!("method:{value}.{name}"))
            .unwrap_or_else(|| format!("func:{name}"));
        if declarations.len() == 512 {
            return Err(
                "Go declaration count exceeds the 512-declaration pilot limit; use file history.",
            );
        }
        declarations.push(Declaration {
            key,
            name: display,
            start: tokens[begin].line,
            end: tokens[end].end_line,
            text: &source[tokens[begin].start..tokens[end].end],
        });
        i = end + 1;
    }
    if braces != 0 {
        return Err("Unbalanced Go braces.");
    }
    Ok(declarations)
}

fn fingerprint(source: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in source.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}
fn compare(old: &str, new: &str) -> Response {
    let (old, new) = match (declarations(old), declarations(new)) {
        (Ok(old), Ok(new)) => (old, new),
        (Err(message), _) | (_, Err(message)) => return unsupported(message),
    };
    if old
        .iter()
        .chain(&new)
        .any(|item| item.text.len() > 16 * 1024)
    {
        return unsupported(
            "A declaration exceeds the 16 KiB source-preview limit; use file history.",
        );
    }
    let mut by_key: BTreeMap<String, (Vec<Declaration<'_>>, Vec<Declaration<'_>>)> =
        BTreeMap::new();
    for item in old {
        by_key.entry(item.key.clone()).or_default().0.push(item);
    }
    for item in new {
        by_key.entry(item.key.clone()).or_default().1.push(item);
    }
    if by_key.is_empty() {
        return unsupported("No supported Go function or method declarations in this file.");
    }
    let has_unmatched = by_key
        .values()
        .any(|(old, new)| old.is_empty() || new.is_empty());
    let has_changed_match = by_key.values().any(|(old, new)| {
        matches!((old.as_slice(), new.as_slice()), ([old], [new]) if old.text != new.text)
    });
    // Exact names alone cannot distinguish a routine edit from extraction into
    // a new helper or merging a removed declaration into a retained one.
    if has_unmatched && has_changed_match {
        return unsupported("Possible function split/merge: an existing declaration changed while another was added or removed. Symbol continuity is uncertain; use file history.");
    }
    let mut symbols = Vec::new();
    let mut ambiguous = false;
    for (key, (old, new)) in by_key {
        let duplicate = old.len() > 1 || new.len() > 1;
        ambiguous |= duplicate;
        let (old, new) = if duplicate {
            (None, None)
        } else {
            (old.first(), new.first())
        };
        let status = if duplicate {
            "ambiguous"
        } else {
            match (old, new) {
                (Some(old), Some(new)) if old.text == new.text => "unchanged",
                (Some(_), Some(_)) => "changed",
                (Some(_), None) => "removed",
                (None, Some(_)) => "added",
                _ => unreachable!(),
            }
        };
        symbols.push(Symbol {
            name: old
                .or(new)
                .map(|item| item.name.clone())
                .unwrap_or_else(|| key.clone()),
            key,
            status,
            old_start: old.map(|item| item.start),
            old_end: old.map(|item| item.end),
            new_start: new.map(|item| item.start),
            new_end: new.map(|item| item.end),
            old_hash: old.map(|item| fingerprint(item.text)),
            new_hash: new.map(|item| fingerprint(item.text)),
            old_source: old.map(|item| item.text.to_owned()),
            new_source: new.map(|item| item.text.to_owned()),
        });
    }
    Response {
        state: if ambiguous { "ambiguous" } else { "ready" },
        policy: POLICY,
        symbols,
        message: if ambiguous {
            Some("Duplicate qualified declarations are not matched; inspect file history.".into())
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comments_strings_raw_literals_and_nested_braces_do_not_invent_functions() {
        let source = "package p\n// func Fake() {}\n/* } func Other() {} */\nfunc Real() { s := `\nfunc Hidden() {}`; _ = s; _ = \"}\\\"{\"; if true { _ = '}' } }\nfunc (s *Store) Put() { }\n";
        let declarations = declarations(source).unwrap();
        assert_eq!(declarations.len(), 2);
        assert_eq!(declarations[0].key, "func:Real");
        assert_eq!(declarations[0].start, 4);
        assert_eq!(declarations[1].key, "method:*Store.Put");
    }
    #[test]
    fn exact_keys_only_and_duplicate_names_are_ambiguous() {
        let result = compare("func A() {}\nfunc B() {}", "func C() {}\nfunc B() {}");
        assert_eq!(result.state, "ready");
        assert_eq!(
            result
                .symbols
                .iter()
                .map(|symbol| symbol.status)
                .collect::<Vec<_>>(),
            ["removed", "unchanged", "added"]
        );
        let result = compare("func init() {}\nfunc init() {}", "func init() {}");
        assert_eq!(result.state, "ambiguous");
        assert_eq!(result.symbols[0].old_start, None);
    }
    #[test]
    fn possible_splits_merges_and_mixed_renames_fail_closed() {
        let cases = [
            (
                "func A() { first(); second() }",
                "func A() { first(); Helper() }\nfunc Helper() { second() }",
            ),
            (
                "func A() { first() }\nfunc B() { second() }",
                "func A() { first(); second() }",
            ),
            (
                "func A() {}\nfunc B() {}",
                "func C() {}\nfunc B() { work() }",
            ),
        ];
        for (old, new) in cases {
            let result = compare(old, new);
            assert_eq!(result.state, "unsupported");
            assert!(result.symbols.is_empty());
            assert!(result.message.unwrap().contains("split/merge"));
        }
    }

    #[test]
    fn renamed_or_moved_bodies_remain_unmatched_without_cross_key_identity() {
        let result = compare("func A() { work() }", "func C() { work() }");
        assert_eq!(result.state, "ready");
        assert_eq!(result.symbols.len(), 2);
        assert_eq!(result.symbols[0].status, "removed");
        assert_eq!(result.symbols[1].status, "added");
        assert!(result.symbols[0].new_source.is_none());
        assert!(result.symbols[1].old_source.is_none());
        assert_eq!(result.symbols[0].key, "func:A");
        assert_eq!(result.symbols[1].key, "func:C");
    }

    #[test]
    fn deletion_only_and_unchanged_reordering_keep_truthful_declaration_states() {
        let result = compare("func A() {}\nfunc B() {}", "func B() {}");
        assert_eq!(result.state, "ready");
        assert_eq!(result.symbols[0].status, "removed");
        assert_eq!(result.symbols[1].status, "unchanged");
        let result = compare("func A() {}\nfunc B() {}", "func B() {}\nfunc A() {}");
        assert_eq!(result.state, "ready");
        assert!(result
            .symbols
            .iter()
            .all(|symbol| symbol.status == "unchanged"));
        assert_eq!(result.symbols[0].old_start, Some(1));
        assert_eq!(result.symbols[0].new_start, Some(2));
    }

    #[test]
    fn unsupported_syntax_and_unterminated_input_fall_back() {
        for source in [
            "func F[T any]() {}",
            "func (s Store[T]) Put() {}",
            "func F() struct { A int } { return struct { A int }{} }",
            "func F()",
            "func F() {",
            "/* unterminated",
            "func F() { _ = `unterminated }",
            "func λ() {}",
        ] {
            assert_eq!(compare(source, "").state, "unsupported", "{source}");
        }
    }
    #[test]
    fn receiver_names_do_not_create_cross_type_or_pointer_matches() {
        let result = compare("func (a A) Get() {}", "func (a B) Get() {}");
        assert_eq!(result.symbols.len(), 2);
        assert!(!result
            .symbols
            .iter()
            .any(|symbol| symbol.status == "changed"));
        let result = compare("func F() {}", "// new preface\nfunc F() {}");
        assert_eq!(result.symbols[0].status, "unchanged");
        assert_eq!(result.symbols[0].new_start, Some(2));
    }

    #[test]
    fn pathological_token_and_declaration_counts_fail_closed() {
        let tokens = format!("func F() {{ {} }}", ";".repeat(100_001));
        assert_eq!(compare("", &tokens).state, "unsupported");
        let declarations = (0..513)
            .map(|index| format!("func F{index}() {{}}\n"))
            .collect::<String>();
        assert_eq!(compare("", &declarations).state, "unsupported");
        assert_eq!(compare("func _() {}", "func _() {}").state, "unsupported");
    }

    #[test]
    fn oversized_declarations_are_explicitly_unsupported_not_silently_truncated() {
        let source = format!("func Big() {{ /* {} */ }}", "x".repeat(17 * 1024));
        let result = compare("", &source);
        assert_eq!(result.state, "unsupported");
        assert!(result.message.unwrap().contains("16 KiB"));
        let result = compare("func A() {}", "func A() { work() }");
        assert_eq!(result.symbols[0].old_source.as_deref(), Some("func A() {}"));
        assert_eq!(
            result.symbols[0].new_source.as_deref(),
            Some("func A() { work() }")
        );
    }

    #[tokio::test]
    async fn endpoint_checks_stack_member_and_path_and_reads_resolved_git_versions() {
        let (repo, stack) = crate::test_support::stack_fixture().await;
        let state = crate::test_support::state();
        state.sessions.lock().unwrap().insert(
            "stack".into(),
            crate::Session {
                comment_pr: None,
                repository: "https://github.com/owner/repo".into(),
                repo: repo.0.clone(),
                base: stack.members[0].base.clone(),
                target: stack.members[0].head.clone(),
                files: vec![],
                commits: vec![],
                stack: Some(stack.clone()),
            },
        );
        let request = |number, path: &str| {
            Json(Request {
                id: "stack".into(),
                number,
                path: path.into(),
            })
        };
        let Json(result) = stack_symbols(State(state.clone()), request(1, "shared.go"))
            .await
            .unwrap();
        assert_eq!(result.state, "ready");
        assert_eq!(result.symbols[0].status, "changed");
        assert_eq!(
            result.symbols[0].old_source.as_deref(),
            Some("func A() { base() }")
        );
        assert_eq!(
            result.symbols[0].new_source.as_deref(),
            Some("func A() { first() }")
        );
        assert!(
            stack_symbols(State(state.clone()), request(999, "shared.go"))
                .await
                .is_err()
        );
        assert!(
            stack_symbols(State(state.clone()), request(1, "outside.go"))
                .await
                .is_err()
        );
        assert_eq!(
            stack_symbols(State(state), request(1, "file.rs"))
                .await
                .unwrap()
                .0
                .state,
            "unsupported"
        );
    }
}
