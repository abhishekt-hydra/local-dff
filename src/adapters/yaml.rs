//! Match YAML values by document, mapping key, and sequence position. The line
//! engine supplies layout only; these source spans supply the semantic changes.
use serde_json::{json, Value};
use std::{collections::BTreeMap, ops::Range};
use tree_sitter::{Node, Parser};
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Part {
    Document(usize),
    Key(String),
    KeyToken,
    Value,
    Index(usize),
    Attribute(String),
    Comment(String, usize),
}

struct Symbol {
    value: String,
    span: Range<usize>,
}

type Symbols = BTreeMap<Vec<Part>, Symbol>;
type Lines = Vec<Vec<Range<usize>>>;

pub struct Changes {
    old: Lines,
    new: Lines,
}

impl Changes {
    pub fn parse(old: &str, new: &str) -> Result<Self, ()> {
        let old_symbols = symbols(old)?;
        let new_symbols = symbols(new)?;
        let changed = |source: &str, left: &Symbols, right: &Symbols| {
            let spans = left.iter().filter_map(|(path, symbol)| {
                (right.get(path).map(|other| &other.value) != Some(&symbol.value))
                    .then_some(symbol.span.clone())
            });
            line_spans(source, spans)
        };
        Ok(Self {
            old: changed(old, &old_symbols, &new_symbols),
            new: changed(new, &new_symbols, &old_symbols),
        })
    }

    pub fn apply(self, patch: &mut Value) -> Result<(), ()> {
        let mut hunks: Vec<Value> = Vec::new();
        for (index, block) in patch["blocks"]
            .as_array_mut()
            .ok_or(())?
            .iter_mut()
            .enumerate()
        {
            let mut changed = false;
            for (column, lines, kind) in [
                ("old_column", &self.old, "removed"),
                ("new_column", &self.new, "added"),
            ] {
                for line in block[column].as_array_mut().ok_or(())? {
                    let row = line["line"]
                        .as_u64()
                        .and_then(|row| row.checked_sub(1))
                        .ok_or(())?;
                    let row = usize::try_from(row).map_err(|_| ())?;
                    let tokens: Vec<_> = lines
                        .get(row)
                        .ok_or(())?
                        .iter()
                        .map(|span| {
                            json!({"id": null, "start": span.start, "end": span.end,
                            "kind": kind, "priority": 0, "group": null})
                        })
                        .collect();
                    changed |= !tokens.is_empty();
                    line["tokens"] = json!(tokens);
                    line["change"] = json!(0);
                    line["newline"] = json!(0);
                }
            }
            block["type"] = json!(if changed { 3 } else { 0 });
            if changed {
                if let Some(last) = hunks
                    .last_mut()
                    .filter(|last| last["block_idx_end"] == index)
                {
                    last["block_idx_end"] = json!(index + 1);
                } else {
                    hunks.push(json!({"block_idx_start": index, "block_idx_end": index + 1}));
                }
            }
        }
        patch["hunks"] = json!(hunks);
        patch["language"] = json!("yaml");
        for field in ["copy_boxes", "orig_boxes", "old_scopes", "new_scopes"] {
            patch[field] = json!([]);
        }
        Ok(())
    }
}

fn symbols(source: &str) -> Result<Symbols, ()> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_yaml::LANGUAGE.into())
        .map_err(|_| ())?;
    #[allow(deprecated)]
    parser.set_timeout_micros(2_000_000);
    let tree = parser.parse(source, None).ok_or(())?;
    if tree.root_node().has_error() {
        return Err(());
    }
    expansion_cost(tree.root_node(), source, &mut BTreeMap::new(), 0)?;
    // Decode complete documents so block-scalar indentation and alias scope
    // retain their meaning. Tree-sitter supplies the original source ranges.
    let documents = Yaml::Array(YamlLoader::load_from_str(source).map_err(|_| ())?);
    let mut symbols = Symbols::new();
    comments(tree.root_node(), source, &mut BTreeMap::new(), &mut symbols);
    visit(
        tree.root_node(),
        source,
        &documents,
        &mut Vec::new(),
        &mut symbols,
        0,
    )?;
    Ok(symbols)
}

fn comments(
    node: Node<'_>,
    source: &str,
    counts: &mut BTreeMap<String, usize>,
    symbols: &mut Symbols,
) {
    if node.kind() == "comment" {
        let text = source[node.byte_range()].to_owned();
        let count = counts.entry(text.clone()).or_default();
        symbols.insert(
            vec![Part::Comment(text.clone(), *count)],
            Symbol {
                value: text,
                span: node.byte_range(),
            },
        );
        *count += 1;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        comments(child, source, counts, symbols);
    }
}

// The YAML loader expands aliases by cloning. Bound the expanded representation
// before asking it to decode a file, and bound traversal depth before recursion.
fn expansion_cost(
    node: Node<'_>,
    source: &str,
    anchors: &mut BTreeMap<String, usize>,
    depth: usize,
) -> Result<usize, ()> {
    if depth > 128 {
        return Err(());
    }
    if node.kind() == "document" {
        anchors.clear();
    }
    if node.kind() == "alias" {
        return anchors
            .get(&source[node.byte_range()][1..])
            .copied()
            .ok_or(());
    }
    let mut cursor = node.walk();
    let children: Vec<_> = node.named_children(&mut cursor).collect();
    let mut cost = 64
        + if children.is_empty() {
            node.byte_range().len()
        } else {
            0
        };
    for child in &children {
        cost += expansion_cost(*child, source, anchors, depth + 1)?;
        if cost > 16 * 1024 * 1024 {
            return Err(());
        }
    }
    if matches!(node.kind(), "block_node" | "flow_node") {
        for anchor in children
            .into_iter()
            .filter(|child| child.kind() == "anchor")
        {
            anchors.insert(source[anchor.byte_range()][1..].into(), cost);
        }
    }
    Ok(cost)
}

fn emit(symbols: &mut Symbols, path: &[Part], node: Node<'_>, value: String) -> Result<(), ()> {
    if symbols
        .insert(
            path.to_vec(),
            Symbol {
                value,
                span: node.byte_range(),
            },
        )
        .is_some()
    {
        return Err(()); // Duplicate keys cannot be matched unambiguously.
    }
    Ok(())
}

fn canonical(value: &Yaml) -> String {
    match value {
        Yaml::Array(items) => format!(
            "array:{}",
            json!(items.iter().map(canonical).collect::<Vec<_>>())
        ),
        Yaml::Hash(items) => {
            let mut pairs: Vec<_> = items
                .iter()
                .map(|(key, value)| (canonical(key), canonical(value)))
                .collect();
            pairs.sort();
            format!("map:{}", json!(pairs))
        }
        _ => format!("{value:?}"),
    }
}

fn visit(
    node: Node<'_>,
    source: &str,
    semantic: &Yaml,
    path: &mut Vec<Part>,
    symbols: &mut Symbols,
    depth: usize,
) -> Result<(), ()> {
    if depth > 128 {
        return Err(());
    }
    let mut cursor = node.walk();
    let children: Vec<_> = node
        .named_children(&mut cursor)
        .filter(|child| child.kind() != "comment")
        .collect();
    match node.kind() {
        "stream" => {
            for (index, child) in children.into_iter().enumerate() {
                path.push(Part::Document(index));
                let document = semantic
                    .as_vec()
                    .and_then(|docs| docs.get(index))
                    .ok_or(())?;
                visit(child, source, document, path, symbols, depth + 1)?;
                path.pop();
            }
        }
        "block_mapping" | "flow_mapping" => {
            emit(symbols, path, node, "mapping".into())?;
            for pair in children {
                let key = pair.child_by_field_name("key").ok_or(())?;
                let mut keys =
                    YamlLoader::load_from_str(&source[key.byte_range()]).map_err(|_| ())?;
                if keys.len() != 1 {
                    return Err(());
                }
                let key_value = keys.pop().unwrap();
                let child_value = semantic
                    .as_hash()
                    .and_then(|map| map.get(&key_value))
                    .ok_or(())?;
                path.push(Part::Key(canonical(&key_value)));
                path.push(Part::KeyToken);
                visit(key, source, &key_value, path, symbols, depth + 1)?;
                path.pop();
                path.push(Part::Value);
                if let Some(child) = pair.child_by_field_name("value") {
                    visit(child, source, child_value, path, symbols, depth + 1)?;
                } else {
                    emit(symbols, path, key, canonical(&Yaml::Null))?;
                }
                path.pop();
                path.pop();
            }
        }
        "block_sequence" | "flow_sequence" => {
            emit(symbols, path, node, "sequence".into())?;
            for (index, child) in children.into_iter().enumerate() {
                path.push(Part::Index(index));
                let item = semantic
                    .as_vec()
                    .and_then(|items| items.get(index))
                    .ok_or(())?;
                visit(child, source, item, path, symbols, depth + 1)?;
                path.pop();
            }
        }
        "plain_scalar" | "single_quote_scalar" | "double_quote_scalar" | "block_scalar" => {
            emit(symbols, path, node, canonical(semantic))?;
        }
        "anchor" | "tag" | "yaml_directive" | "tag_directive" | "reserved_directive" => {
            path.push(Part::Attribute(node.kind().into()));
            emit(symbols, path, node, source[node.byte_range()].into())?;
            path.pop();
        }
        "alias" => emit(
            symbols,
            path,
            node,
            format!("alias:{}", &source[node.byte_range()]),
        )?,
        "document" | "block_node" | "flow_node" | "block_sequence_item" => {
            if node.kind() == "document" {
                path.push(Part::Attribute("document".into()));
                emit(symbols, path, node, "document".into())?;
                path.pop();
            }
            if children.is_empty() && node.kind() == "block_sequence_item" {
                emit(symbols, path, node, canonical(&Yaml::Null))?;
            }
            for child in children {
                visit(child, source, semantic, path, symbols, depth + 1)?;
            }
        }
        _ => return Err(()),
    }
    Ok(())
}

fn line_spans(source: &str, spans: impl Iterator<Item = Range<usize>>) -> Lines {
    let mut offset = 0;
    let lines: Vec<_> = source
        .split_inclusive('\n')
        .map(|line| {
            let start = offset;
            offset += line.len();
            (start, line.trim_end_matches(['\r', '\n']))
        })
        .collect();
    let mut result = vec![Vec::new(); lines.len()];
    for span in spans {
        let first = lines
            .partition_point(|(start, _)| *start <= span.start)
            .saturating_sub(1);
        for (row, (start, content)) in lines.iter().enumerate().skip(first) {
            if *start >= span.end {
                break;
            }
            let begin = span.start.saturating_sub(*start).min(content.len());
            let end = span.end.saturating_sub(*start).min(content.len());
            if begin < end {
                result[row].push(content[..begin].chars().count()..content[..end].chars().count());
            }
        }
    }
    for spans in &mut result {
        spans.sort_by_key(|span| span.start);
        let mut merged: Vec<Range<usize>> = Vec::new();
        for span in spans.drain(..) {
            if let Some(last) = merged.last_mut().filter(|last| last.end >= span.start) {
                last.end = last.end.max(span.end);
            } else {
                merged.push(span);
            }
        }
        *spans = merged;
    }
    result
}
