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
            let mut request = json!({
                "old_content": input.contents.old, "new_content": input.contents.new,
                "extension": input.extension, "fallback": true,
                "options": { "ignore_comments": false }
            });
            let yaml = input.extension.eq_ignore_ascii_case(".yaml")
                || input.extension.eq_ignore_ascii_case(".yml");
            let changes =
                yaml.then(|| super::yaml::Changes::parse(&input.contents.old, &input.contents.new));
            // Reuse the line engine's layout while matching YAML values locally.
            if yaml {
                request["language"] = json!("text_lines");
            }
            let payload = serde_json::to_vec(&request)
                .map_err(|e| DiffError::InvalidSemantic(e.to_string()))?;
            let mut command = Command::new(binary);
            command.arg("--diff-stdin");
            let bytes = output(command, "SemanticDiff", Some(payload), 16 * 1024 * 1024).await?;
            let mut patch = serde_json::from_slice(&bytes)
                .map_err(|e| DiffError::InvalidSemantic(e.to_string()))?;
            match changes {
                Some(Ok(changes)) => changes.apply(&mut patch).map_err(|()| {
                    DiffError::InvalidSemantic(
                        "SemanticDiff returned an invalid YAML layout".into(),
                    )
                })?,
                Some(Err(())) => {
                    patch["fallback"] = json!(true);
                    patch["error"] = json!({"type": "parser_error",
                        "message": "YAML could not be matched safely; showing a line diff.",
                        "old_errors": [], "new_errors": []});
                }
                None => {}
            }
            Ok(patch)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::FileContents;

    fn engine() -> SemanticCli {
        SemanticCli::new(
            std::env::var_os("SEMANTICDIFF_EXTENSION_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/semanticdiff/extension")
                })
                .join("bin/semanticdiff"),
        )
    }

    #[tokio::test]
    async fn yaml_renders_original_lines_without_an_unsupported_language_error() {
        let engine = engine();
        let old =
            "---\n# deployment\ndefaults: &defaults\n  replicas: 1\nservice: *defaults\n---\nname: app\n";
        let new =
            "---\n# deployment 😀\ndefaults: &defaults\n  replicas: 2\nservice: *defaults\n---\nname: app\n";
        for extension in [".yaml", ".yml", ".YAML", ".YML"] {
            for (old, new) in [(old, new), ("", new), (old, "")] {
                let patch = engine
                    .compare(SemanticInput {
                        contents: FileContents {
                            old: old.into(),
                            new: new.into(),
                        },
                        extension: extension.into(),
                    })
                    .await
                    .unwrap();
                assert_eq!(patch["language"], "yaml");
                assert_eq!(patch["fallback"], false);
                assert!(patch["error"].is_null());
                for (column, source) in [("old_column", old), ("new_column", new)] {
                    let lines: Vec<_> = patch["blocks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .flat_map(|block| block[column].as_array().unwrap())
                        .collect();
                    assert_eq!(lines.len(), source.lines().count());
                    for (line, content) in lines.iter().zip(source.lines()) {
                        assert_eq!(line["content"], content);
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn yaml_distinguishes_semantic_changes_from_formatting_and_key_order() {
        let engine = engine();
        for (old, new, changed) in [
            ("a: 1\nb: two\n", "b: 'two'\na: 1\n", false),
            (
                "a:\n  b: true\n  c: text\n",
                "a: {c: \"text\", b: true}\n",
                false,
            ),
            (
                "a: |\n  hello\n  world\n",
                "a: \"hello\\nworld\\n\"\n",
                false,
            ),
            ("a:\n", "a: null\n", false),
            ("a: [1, 2]\n", "a:\n  - 1\n  - 2\n", false),
            (
                "a:\n  b: |2\n    hello\n",
                "a:\n    b: \"hello\\n\"\n",
                false,
            ),
            ("a: 1\nb: two\n", "b: 'two'\na: 2\n", true),
            ("😀: old\n", "😀: new\n", true),
            ("a: 1\n", "a: 1\n---\n", true),
            ("a: 1\n", "a: 2\n", true),
            ("a: true\n", "a: 'true'\n", true),
            ("a: [1, 2]\n", "a: [2, 1]\n", true),
            ("a: {}\n", "a: []\n", true),
            ("a:\n  b: 1\n", "b:\n  a: 1\n", true),
            ("# old\na: 1\n", "# new\na: 1\n", true),
            ("a: 1 # old\n", "a: 1 # new\n", true),
            ("a: &x 1\nb: *x\n", "a: &x 2\nb: *x\n", true),
            ("a: &x 1\nb: *x\n", "a: &y 1\nb: *y\n", true),
            ("a: 1\n---\na: 2\n", "a: 2\n---\na: 1\n", true),
        ] {
            let patch = engine
                .compare(SemanticInput {
                    contents: FileContents {
                        old: old.into(),
                        new: new.into(),
                    },
                    extension: ".yaml".into(),
                })
                .await
                .unwrap();
            assert_eq!(patch["fallback"], false, "{old:?} => {new:?}: {patch}");
            assert_eq!(
                !patch["hunks"].as_array().unwrap().is_empty(),
                changed,
                "{old:?} => {new:?}: {patch}"
            );
        }
    }

    #[tokio::test]
    async fn ambiguous_or_invalid_yaml_keeps_a_labeled_text_diff() {
        let engine = engine();
        let mut expanded = "a0: &a0 [value]\n".to_owned();
        for index in 1..24 {
            expanded.push_str(&format!(
                "a{index}: &a{index} [*a{}, *a{}]\n",
                index - 1,
                index - 1
            ));
        }
        for new in ["a: [\n", "a: 1\na: 2\n", "a: *undefined\n", &expanded] {
            let patch = engine
                .compare(SemanticInput {
                    contents: FileContents {
                        old: "a: 1\n".into(),
                        new: new.into(),
                    },
                    extension: ".yml".into(),
                })
                .await
                .unwrap();
            assert_eq!(patch["fallback"], true);
            assert_eq!(patch["error"]["type"], "parser_error");
            assert!(!patch["blocks"].as_array().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn reordered_yaml_highlights_only_the_changed_value_at_its_original_coordinates() {
        let patch = engine()
            .compare(SemanticInput {
                contents: FileContents {
                    old: "name: '😀app'\nreplicas: 1\n".into(),
                    new: "replicas: 2\nname: \"😀app\"\n".into(),
                },
                extension: ".yaml".into(),
            })
            .await
            .unwrap();
        for (column, row, kind) in [("old_column", 2, "removed"), ("new_column", 1, "added")] {
            let changed: Vec<_> = patch["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|block| block[column].as_array().unwrap())
                .filter(|line| !line["tokens"].as_array().unwrap().is_empty())
                .map(|line| json!({"line": line["line"], "tokens": line["tokens"]}))
                .collect();
            assert_eq!(
                changed,
                vec![json!({"line": row, "tokens": [{
                    "id": null, "start": 10, "end": 11, "kind": kind, "priority": 0, "group": null
                }]})]
            );
        }
    }
}
