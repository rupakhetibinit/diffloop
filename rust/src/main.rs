use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response, Sse},
    routing::{get, post},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use chrono::{Local, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    env, fs,
    path::{Path as FsPath, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock, atomic::{AtomicU64, Ordering}},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_stream::wrappers::BroadcastStream;

const INDEX: &str = include_str!("../assets/index.html");
const APP_JS: &str = include_str!("../assets/app.js");
const APP_CSS: &str = include_str!("../assets/app.css");
const VERSION: &str = "0.2.3";
const REPO: &str = "rupakhetibinit/diffloop";

static EVENTS: OnceLock<tokio::sync::broadcast::Sender<String>> = OnceLock::new();

fn emit(event: &str) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(event.to_string());
    }
}

fn log(message: impl AsRef<str>) {
    eprintln!("[diffloop {}] {}", Local::now().format("%H:%M:%S"), message.as_ref());
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Message {
    id: String,
    author: String,
    body: String,
    at: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    path: String,
    side: String,
    line: usize,
    anchor: String,
    messages: Vec<Message>,
    status: String,
    round: u32,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    id: String,
    path: String,
    name: String,
    start_line: usize,
    end_line: usize,
    level: String,
    kind: String,
    header: String,
    first_lines: Vec<String>,
    full_text: String,
    changed_lines: Vec<usize>,
    extra_lines: Vec<usize>,
}

struct App {
    repo: PathBuf,
    base: String,
    patch: String,
    signature: String,
    token: String,
    threads: Vec<Thread>,
    state: Value,
    stamps: Vec<(PathBuf, SystemTime, u64)>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn short_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    let seed = nanos ^ (seq << 32) ^ ((std::process::id() as u64) << 48);
    format!("{seed:012x}")
}

fn new_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{nanos:x}-{:x}", std::process::id())
}

fn home() -> PathBuf {
    for key in ["HOME", "USERPROFILE"] {
        if let Some(value) = env::var_os(key) {
            let path = PathBuf::from(value);
            if path.is_absolute() { return path; }
        }
    }
    if cfg!(windows) {
        if let (Some(drive), Some(path)) = (env::var_os("HOMEDRIVE"), env::var_os("HOMEPATH")) {
            let path = PathBuf::from(format!("{}{}", drive.to_string_lossy(), path.to_string_lossy()));
            if path.is_absolute() { return path; }
        }
    }
    env::temp_dir()
}

fn git(repo: &FsPath, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(repo).args(args).output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_patch(repo: &FsPath, base: &str) -> String {
    let tracked = git(repo, &["diff", "--no-ext-diff", "--no-color", "--unified=3", base, "--"])
        .unwrap_or_default();
    let untracked = git(repo, &["ls-files", "--others", "--exclude-standard", "-z"])
        .unwrap_or_default();
    let mut additions = String::new();
    for path in untracked.split('\0').filter(|p| !p.is_empty()) {
        if let Ok(contents) = fs::read_to_string(repo.join(path)) {
            let lines: Vec<&str> = contents.split('\n').collect();
            additions.push_str(&format!(
                "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n",
                lines.len()
            ));
            for line in lines {
                additions.push_str(&format!("+{line}\n"));
            }
        }
    }
    format!("{tracked}{additions}")
}

fn working_lines(repo: &FsPath, path: &str) -> Vec<String> {
    fs::read_to_string(repo.join(path))
        .map(|s| s.split('\n').map(str::to_string).collect())
        .unwrap_or_default()
}

fn base_lines(repo: &FsPath, path: &str, base: &str) -> Vec<String> {
    git(repo, &["show", &format!("{base}:{path}")])
        .map(|s| s.split('\n').map(str::to_string).collect())
        .unwrap_or_default()
}

fn changed_lines(patch: &str, path: &str) -> Vec<usize> {
    let mut current = String::new();
    let mut new_line = 0usize;
    let mut in_hunk = false;
    let mut result = Vec::new();
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git a/") {
            current = rest.split(" b/").last().unwrap_or("").to_string();
            in_hunk = false;
        } else if line.starts_with("@@ ") {
            new_line = line.split('+').nth(1)
                .and_then(|s| s.split([',', ' ']).next())
                .and_then(|s| s.parse().ok()).unwrap_or(0);
            in_hunk = current == path;
        } else if in_hunk && line.starts_with('+') && !line.starts_with("+++") {
            result.push(new_line);
            new_line += 1;
        } else if in_hunk && line.starts_with(' ') {
            new_line += 1;
        }
    }
    result
}

fn grammar_file_for(path: &str) -> Option<&'static str> {
    Some(match path.rsplit('.').next().unwrap_or("") {
        "ts" => "tree-sitter-typescript.wasm",
        "tsx" => "tree-sitter-tsx.wasm",
        "js" | "jsx" => "tree-sitter-javascript.wasm",
        "rs" => "tree-sitter-rust.wasm",
        "cs" => "tree-sitter-c_sharp.wasm",
        "py" => "tree-sitter-python.wasm",
        "go" => "tree-sitter-go.wasm",
        _ => return None,
    })
}

fn mark_cached(name: &str) {
    let path = home().join(".cache/diffloop/grammars").join(name);
    if !path.exists() {
        if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
        let _ = fs::write(path, b"");
    }
}

fn language_for(path: &str) -> Option<tree_sitter::Language> {
    let ext = path.rsplit('.').next().unwrap_or("");
    Some(match ext {
        "ts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "js" | "jsx" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "cs" => tree_sitter_c_sharp::LANGUAGE.into(),
        "py" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        _ => return None,
    })
}

fn function_kind(kind: &str) -> bool {
    matches!(kind,
        "function_declaration" | "function_definition" | "function_item" | "method_declaration"
        | "class_declaration" | "struct_item" | "impl_item")
}

fn block_kind(kind: &str) -> bool {
    matches!(kind,
        "for_statement" | "for_in_statement" | "for_of_statement" | "foreach_statement" | "for_expression"
        | "while_statement" | "while_expression" | "if_statement" | "if_expression"
        | "switch_statement" | "match_expression" | "try_statement" | "try_expression")
}

fn collect_scopes(repo: &FsPath, patch: &str, paths: &[String]) -> Vec<Scope> {
    let mut all: Vec<(Scope, usize)> = Vec::new();
    let supported = paths.iter().any(|path| grammar_file_for(path).is_some());
    if supported {
        for name in [
            "tree-sitter-javascript.wasm", "tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm",
            "tree-sitter-html.wasm", "tree-sitter-css.wasm", "tree-sitter-json.wasm",
            "tree-sitter-perl.wasm", "tree-sitter-SQL.wasm", "tree-sitter-xml.wasm",
            "tree-sitter-markdown.wasm", "tree-sitter-vue.wasm", "tree-sitter-yaml.wasm",
        ] { mark_cached(name); }
    }
    for path in paths {
        if let Some(name) = grammar_file_for(path) { mark_cached(name); }
        let Some(language) = language_for(path) else { continue };
        let Ok(contents) = fs::read_to_string(repo.join(path)) else { continue };
        let mut parser = tree_sitter::Parser::new();
        if parser.set_language(&language).is_err() { continue; }
        let Some(tree) = parser.parse(&contents, None) else { continue };
        let source: Vec<&str> = contents.split('\n').collect();
        let touched = changed_lines(patch, path);
        if touched.is_empty() { continue; }

        let mut stack = vec![tree.root_node()];
        while let Some(node) = stack.pop() {
            let kind = node.kind();
            let level = if function_kind(kind) { Some("function") }
                else if block_kind(kind) { Some("block") } else { None };
            if let Some(level) = level {
                let start = node.start_position().row + 1;
                let end = node.end_position().row + 1;
                let relevant: Vec<usize> = touched.iter().copied()
                    .filter(|line| *line >= start && *line <= end).collect();
                if !relevant.is_empty() {
                    let header = source.get(start - 1).copied().unwrap_or("").trim().to_string();
                    let name: String = header.chars().take(80).collect();
                    let mut extra = Vec::new();
                    let mut cursor = node.walk();
                    for child in node.children(&mut cursor) {
                        let ck = child.kind();
                        if (kind.contains("try") && matches!(ck, "catch_clause" | "finally_clause" | "except_clause"))
                            || (kind.contains("if") && ck == "else_clause")
                        {
                            extra.push(child.start_position().row + 1);
                        }
                    }
                    let first_lines: Vec<String> = source.iter().skip(start - 1).take(10)
                        .map(|line| line.to_string()).collect();
                    let full_text = source.iter().skip(start - 1)
                        .take(end.saturating_sub(start - 1).min(200))
                        .cloned().collect::<Vec<_>>().join("\n");
                    all.push((Scope {
                        id: format!("{path}:{start}:{kind}"),
                        path: path.clone(), name, start_line: start, end_line: end,
                        level: level.to_string(), kind: kind.to_string(),
                        header: header.clone(), first_lines, full_text,
                        changed_lines: relevant, extra_lines: extra,
                    }, end.saturating_sub(start)));
                }
            }
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) { stack.push(child); }
        }
    }

    let mut best: HashMap<(String, String, usize), usize> = HashMap::new();
    for (index, (scope, span)) in all.iter().enumerate() {
        for line in &scope.changed_lines {
            let key = (scope.path.clone(), scope.level.clone(), *line);
            match best.get(&key) {
                Some(previous) if all[*previous].1 <= *span => {}
                _ => { best.insert(key, index); }
            }
        }
    }
    let mut scopes: Vec<Scope> = Vec::new();
    for (index, (scope, _)) in all.iter().enumerate() {
        let mut lines: Vec<usize> = best.iter()
            .filter(|(_, chosen)| **chosen == index)
            .map(|((_, _, line), _)| *line).collect();
        if lines.is_empty() { continue; }
        lines.sort_unstable();
        lines.dedup();
        let mut kept_scope = scope.clone();
        kept_scope.changed_lines = lines;
        scopes.push(kept_scope);
    }
    scopes.sort_by_key(|scope| scope.start_line);
    for scope in &mut scopes {
        scope.changed_lines.sort_unstable();
        scope.changed_lines.dedup();
    }
    scopes
}

fn augment(repo: &FsPath, patch: &str, scopes: &[Scope], base: &str) -> String {
    let mut result = String::new();
    for piece in patch.split("diff --git ").filter(|s| !s.trim().is_empty()) {
        let section = format!("diff --git {piece}");
        let header_end = section.find("@@ ").unwrap_or(section.len());
        let header = &section[..header_end];
        let body = &section[header_end..];
        let path = section.lines().next()
            .and_then(|line| line.split(" b/").last())
            .unwrap_or("").to_string();
        let new_lines = working_lines(repo, &path);
        let old_lines = base_lines(repo, &path, base);
        let mut insertions: Vec<(usize, String)> = Vec::new();
        let mut occupied = 0usize;
        let mut ordered: Vec<&Scope> = scopes.iter()
            .filter(|s| s.path == path && !s.changed_lines.is_empty()).collect();
        ordered.sort_by_key(|s| (s.start_line, if s.level == "function" { 0 } else { 1 }));
        for scope in ordered {
            let start = scope.start_line;
            if start <= occupied || new_lines.is_empty() { continue; }
            let next_hunk = body.lines().filter(|l| l.starts_with("@@ "))
                .filter_map(|l| l.split('+').nth(1).and_then(|s| s.split([',', ' ']).next()).and_then(|s| s.parse::<usize>().ok()))
                .filter(|line| *line >= start).min().unwrap_or(usize::MAX);
            let first_changed = *scope.changed_lines.iter().min().unwrap_or(&start);
            let desired = if scope.level == "function" { 1 } else { 4 };
            let count = (start + desired).min(next_hunk).min(first_changed).min(scope.end_line + 1).saturating_sub(start);
            if count > 0 {
                let mut chunk = format!("@@ -{start},{count} +{start},{count} @@\n");
                for offset in 0..count {
                    let text = new_lines.get(start + offset - 1).or_else(|| old_lines.get(start + offset - 1)).map(String::as_str).unwrap_or("");
                    chunk.push_str(&format!(" {text}\n"));
                }
                insertions.push((start, chunk));
                occupied = start + count - 1;
            }
            for extra in &scope.extra_lines {
                if *extra <= occupied || *extra >= first_changed || *extra >= next_hunk { continue; }
                let text = new_lines.get(extra - 1).map(String::as_str).unwrap_or("");
                insertions.push((*extra, format!("@@ -{extra},1 +{extra},1 @@\n {text}\n")));
                occupied = *extra;
            }
        }
        result.push_str(header);
        for line in body.lines() {
            if line.starts_with("@@ ") {
                let hunk_start = line.split('+').nth(1)
                    .and_then(|s| s.split([',', ' ']).next()).and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                for (_, text) in insertions.iter().filter(|(s, _)| *s < hunk_start) {
                    result.push_str(text);
                }
            }
            result.push_str(line);
            result.push('\n');
        }
        let last_hunk_start = body.lines().filter(|l| l.starts_with("@@ "))
            .filter_map(|l| l.split('+').nth(1).and_then(|s| s.split([',', ' ']).next()).and_then(|s| s.parse::<usize>().ok()))
            .max().unwrap_or(0);
        for (_, text) in insertions.iter().filter(|(start, _)| *start >= last_hunk_start) {
            result.push_str(text);
        }
    }
    result
}

fn changed_paths(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines().filter(|l| l.starts_with("diff --git ")) {
        if let Some(path) = line.split(" b/").last() {
            if !paths.contains(&path.to_string()) { paths.push(path.to_string()); }
        }
    }
    paths
}

fn threads_path(repo: &FsPath) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(repo.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    home().join(".local/share/diffloop").join(key).join("threads.json")
}

fn load_threads(repo: &FsPath) -> Vec<Thread> {
    let Some(text) = fs::read_to_string(threads_path(repo)).ok() else { return Vec::new() };
    let mut threads: Vec<Thread> = if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if let Some(list) = value.get("threads") {
            serde_json::from_value(list.clone()).unwrap_or_default()
        } else {
            serde_json::from_value(value).unwrap_or_default()
        }
    } else {
        log(format!("could not parse {}", threads_path(repo).display()));
        Vec::new()
    };
    let mut seen = HashSet::new();
    let mut migrated = false;
    for thread in &mut threads {
        if thread.id.is_empty() || !seen.insert(thread.id.clone()) {
            thread.id = short_id();
            migrated = true;
        }
    }
    if migrated { save_threads(repo, &threads); }
    threads
}

fn save_threads(repo: &FsPath, threads: &[Thread]) {
    let path = threads_path(repo);
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            log(format!("could not create {}: {error}", parent.display()));
            return;
        }
    }
    let payload = json!({ "repo": repo.to_string_lossy(), "threads": threads });
    if let Err(error) = fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default()) {
        log(format!("could not write {}: {error}", path.display()));
    }
}

fn reanchor(repo: &FsPath, threads: &mut [Thread]) {
    for thread in threads.iter_mut() {
        if thread.status == "dismissed" || thread.anchor.is_empty() { continue; }
        let lines = working_lines(repo, &thread.path);
        if lines.is_empty() { continue; }
        let needle = thread.anchor.trim();
        if lines.get(thread.line - 1).map(|s| s.trim()) == Some(needle) {
            if thread.status == "stale" { thread.status = "open".into(); }
            continue;
        }
        let mut found = None;
        for distance in 1..=20 {
            if lines.get(thread.line - 1 + distance).map(|s| s.trim()) == Some(needle) {
                found = Some(thread.line + distance); break;
            }
            if thread.line > distance && lines.get(thread.line - 1 - distance).map(|s| s.trim()) == Some(needle) {
                found = Some(thread.line - distance); break;
            }
        }
        match found {
            Some(line) => {
                if line != thread.line { thread.line = line; thread.updated_at = now(); }
                if thread.status == "stale" { thread.status = "open".into(); }
            }
            None => if thread.status != "stale" {
                thread.status = "stale".into();
                thread.updated_at = now();
            },
        }
    }
}

fn registry_path() -> PathBuf {
    home().join(".config/diffloop/daemons.json")
}

fn read_registry() -> HashMap<String, Value> {
    fs::read_to_string(registry_path())
        .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_registry(registry: &HashMap<String, Value>) {
    let path = registry_path();
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            log(format!("could not create {}: {error}", parent.display()));
            return;
        }
    }
    if let Err(error) = fs::write(&path, serde_json::to_string_pretty(registry).unwrap_or_default()) {
        log(format!("could not write {}: {error}", path.display()));
    }
}

fn find_daemon(repo: &FsPath) -> Option<Value> {
    read_registry().get(&repo.to_string_lossy().to_string()).cloned()
}

fn target_repo(args: &[String]) -> PathBuf {
    if let Some(path) = flag(args, "repo") {
        return FsPath::new(&path).canonicalize().unwrap_or_else(|_| FsPath::new(&path).to_path_buf());
    }
    let output = Command::new("git").arg("-C").arg(".").args(["rev-parse", "--show-toplevel"]).output();
    output.ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let key = format!("--{name}");
    args.windows(2).find(|w| w[0] == key).map(|w| w[1].clone())
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == &format!("--{name}"))
}

fn control(repo: &FsPath, path: &str, method: &str, body: Option<Value>) -> Result<Value, String> {
    let daemon = find_daemon(repo).ok_or_else(|| format!("no diffloop server for {}", repo.display()))?;
    let port = daemon.get("port").and_then(Value::as_u64).unwrap_or(0);
    let token = daemon.get("token").and_then(Value::as_str).unwrap_or("");
    let url = format!("http://127.0.0.1:{port}{path}");
    let response = if method == "POST" {
        let request = ureq::post(&url).header("Authorization", &format!("Bearer {token}"));
        if let Some(payload) = body {
            request.header("Content-Type", "application/json").send_json(payload)
        } else {
            request.send("{}")
        }
    } else {
        ureq::get(&url).header("Authorization", &format!("Bearer {token}")).call()
    }.map_err(|e| e.to_string())?;
    let text = response.into_body().read_to_string().map_err(|e| e.to_string())?;
    if text.trim().is_empty() { Ok(Value::Null) }
    else { serde_json::from_str(&text).map_err(|e| e.to_string()) }
}

fn file_stamps(repo: &FsPath, patch: &str) -> Vec<(PathBuf, SystemTime, u64)> {
    changed_paths(patch).into_iter().map(|path| {
        let full = repo.join(path);
        match fs::metadata(&full) {
            Ok(meta) => (full, meta.modified().unwrap_or(UNIX_EPOCH), meta.len()),
            Err(_) => (full, UNIX_EPOCH, 0),
        }
    }).collect()
}

fn repo_signature(repo: &FsPath, base: &str) -> String {
    let head = git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).unwrap_or_default();
    let base_commit = git(repo, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])
        .unwrap_or_default();
    let status = git(repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).unwrap_or_default();
    format!("{base}\0{base_commit}\0{head}\0{status}")
}

fn signature_reason(previous: &str, current: &str) -> &'static str {
    let old: Vec<&str> = previous.split('\0').collect();
    let new: Vec<&str> = current.split('\0').collect();
    if old.get(0) != new.get(0) { "base changed" }
    else if old.get(1) != new.get(1) { "base moved" }
    else if old.get(2) != new.get(2) { "HEAD changed" }
    else if old.get(3) != new.get(3) { "working tree changed" }
    else { "file changed" }
}

fn rebuild_state(app: &mut App) {
    let signature = repo_signature(&app.repo, &app.base);
    app.patch = build_patch(&app.repo, &app.base);
    let (state, stamps) = derive_state(&app.repo, &app.patch, &app.base);
    app.state = state;
    app.stamps = stamps;
    app.signature = signature;
}

fn refresh_state(app: &mut App) -> bool {
    let signature = repo_signature(&app.repo, &app.base);
    let file_changed = file_stamps(&app.repo, &app.patch) != app.stamps;
    if signature == app.signature && !file_changed {
        return false;
    }
    let reason = if signature == app.signature { "file changed" } else { signature_reason(&app.signature, &signature) };
    rebuild_state(app);
    let stats = &app.state["stats"];
    log(format!(
        "{reason} · {} file(s) (+{} -{})",
        stats["files"].as_u64().unwrap_or(0),
        stats["additions"].as_u64().unwrap_or(0),
        stats["deletions"].as_u64().unwrap_or(0),
    ));
    true
}

fn watch_repo(app: Arc<Mutex<App>>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            let changed = {
                let mut app = app.lock().unwrap();
                refresh_state(&mut app)
            };
            if changed { emit("{\"type\":\"diff\"}"); }
        }
    });
}

fn derive_state(repo: &FsPath, patch: &str, base: &str) -> (Value, Vec<(PathBuf, SystemTime, u64)>) {
    let paths = changed_paths(patch);
    let scopes = collect_scopes(repo, patch, &paths);
    let additions = patch.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
    let deletions = patch.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
    (json!({
        "repo": repo.to_string_lossy(),
        "base": base,
        "patch": augment(repo, patch, &scopes, base),
        "functions": scopes,
        "stats": { "files": paths.len(), "additions": additions, "deletions": deletions },
    }), file_stamps(repo, patch))
}

fn sync_threads(app: &mut App) -> Vec<Thread> {
    let mut threads = app.threads.clone();
    let before = threads.clone();
    reanchor(&app.repo, &mut threads);
    if threads != before {
        app.threads = threads.clone();
        save_threads(&app.repo, &threads);
    }
    threads
}

fn state_response(app: &mut App) -> Value {
    refresh_state(app);
    let threads = sync_threads(app);
    let mut state = app.state.clone();
    state["threads"] = json!(threads);
    state
}

async fn index() -> Html<&'static str> { Html(INDEX) }
async fn app_js() -> Response {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP_JS).into_response()
}
async fn app_css() -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], APP_CSS).into_response()
}

async fn api_state(State(state): State<Arc<Mutex<App>>>) -> Json<Value> {
    let mut app = state.lock().unwrap();
    Json(state_response(&mut app))
}

async fn api_events() -> Sse<impl stream::Stream<Item = Result<axum::response::sse::Event, Infallible>>> {
    let rx = EVENTS.get().unwrap().subscribe();
    let initial = stream::once(async {
        Ok::<_, Infallible>(axum::response::sse::Event::default().data("{\"type\":\"connected\"}"))
    });
    let updates = BroadcastStream::new(rx)
        .filter_map(|item| async move { item.ok() })
        .map(|data| Ok(axum::response::sse::Event::default().data(data)));
    Sse::new(initial.chain(updates))
}

async fn api_branches(State(state): State<Arc<Mutex<App>>>) -> Json<Value> {
    let repo = state.lock().unwrap().repo.clone();
    let branches = git(&repo, &["branch", "--all", "--format=%(refname:short)"])
        .unwrap_or_default().lines().map(str::to_string).collect::<Vec<_>>();
    Json(json!({ "branches": branches }))
}

async fn api_base(State(state): State<Arc<Mutex<App>>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut app = state.lock().unwrap();
    let base = body.get("base").and_then(Value::as_str).unwrap_or("HEAD").to_string();
    if git(&app.repo, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
        log(format!("base {base} rejected: unknown ref"));
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("unknown ref {base}") }))).into_response();
    }
    app.base = base.clone();
    rebuild_state(&mut app);
    let stats = &app.state["stats"];
    log(format!(
        "base -> {base} · {} file(s) (+{} -{})",
        stats["files"].as_u64().unwrap_or(0),
        stats["additions"].as_u64().unwrap_or(0),
        stats["deletions"].as_u64().unwrap_or(0),
    ));
    let mut registry = read_registry();
    if let Some(entry) = registry.get_mut(&app.repo.to_string_lossy().to_string()) {
        entry["base"] = json!(base);
    }
    write_registry(&registry);
    emit("{\"type\":\"diff\"}");
    Json(json!({ "base": base })).into_response()
}

fn add_thread(app: &mut App, body: &Value, author: &str) -> Thread {
    let repo = app.repo.clone();
    let path = body.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    let line = body.get("line").and_then(Value::as_u64).unwrap_or(0) as usize;
    let text = body.get("body").and_then(Value::as_str).unwrap_or("").to_string();
    let anchor = working_lines(&repo, &path).get(line - 1).cloned().unwrap_or_default();
    let time = now();
    let thread = Thread {
        id: short_id(),
        path,
        side: body.get("side").and_then(Value::as_str).unwrap_or("additions").to_string(),
        line, anchor,
        messages: vec![Message { id: short_id(), author: author.into(), body: text, at: time.clone() }],
        status: "open".into(), round: 1, created_at: time.clone(), updated_at: time,
    };
    app.threads.push(thread.clone());
    save_threads(&repo, &app.threads);
    log(format!("comment added {}:{} by {author}", thread.path, thread.line));
    emit("{\"type\":\"threads\"}");
    thread
}

async fn api_threads(State(state): State<Arc<Mutex<App>>>, Json(body): Json<Value>) -> Response {
    let mut app = state.lock().unwrap();
    Json(add_thread(&mut app, &body, "you")).into_response()
}

async fn api_threads_list(State(state): State<Arc<Mutex<App>>>) -> Json<Value> {
    let mut app = state.lock().unwrap();
    Json(json!(sync_threads(&mut app)))
}

async fn ctl_threads(State(state): State<Arc<Mutex<App>>>, headers: HeaderMap, method: axum::http::Method, body: Option<Json<Value>>) -> Response {
    let mut app = state.lock().unwrap();
    if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(|v| v.strip_prefix("Bearer ").unwrap_or(v)) != Some(app.token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if method == axum::http::Method::POST {
        let payload = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
        return Json(add_thread(&mut app, &payload, "agent")).into_response();
    }
    let threads: Vec<Thread> = sync_threads(&mut app).into_iter()
        .filter(|t| ["open", "sent", "stale"].contains(&t.status.as_str())).collect();
    Json(threads).into_response()
}

async fn thread_action_inner(
    state: Arc<Mutex<App>>,
    headers: HeaderMap,
    id: String,
    action: String,
    body: Option<Json<Value>>,
    is_ctl: bool,
) -> Response {
    let mut app = state.lock().unwrap();
    let authorized = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v)) == Some(app.token.as_str());
    if is_ctl && !authorized { return StatusCode::UNAUTHORIZED.into_response(); }
    let payload = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let text = payload.get("body").or_else(|| payload.get("reply"))
        .and_then(Value::as_str).unwrap_or("").to_string();
    let author = if is_ctl { "agent" } else { "you" };
    let Some(thread) = app.threads.iter_mut().find(|t| t.id == id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match action.as_str() {
        "reply" | "note" | "resolve" => {
            if !text.is_empty() {
                thread.messages.push(Message { id: short_id(), author: author.into(), body: text, at: now() });
            }
            if action == "resolve" { thread.status = "resolved".into(); }
            else if thread.status == "resolved" {
                thread.status = "open".into();
                thread.round += 1;
            }
        }
        "send" => if thread.status == "open" || thread.status == "stale" { thread.status = "sent".into() },
        "dismiss" => thread.status = if thread.status == "dismissed" { "open".into() } else { "dismissed".into() },
        _ => return StatusCode::NOT_FOUND.into_response(),
    }
    thread.updated_at = now();
    log(format!("{action} {}:{} -> {} [{author}]", thread.path, thread.line, thread.status));
    let result = thread.clone();
    save_threads(&app.repo, &app.threads);
    emit("{\"type\":\"threads\"}");
    Json(result).into_response()
}

async fn api_thread_action(
    State(state): State<Arc<Mutex<App>>>,
    headers: HeaderMap,
    Path((id, action)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> Response {
    thread_action_inner(state, headers, id, action, body, false).await
}

async fn ctl_thread_action(
    State(state): State<Arc<Mutex<App>>>,
    headers: HeaderMap,
    Path((id, action)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> Response {
    thread_action_inner(state, headers, id, action, body, true).await
}

async fn ctl_status(State(state): State<Arc<Mutex<App>>>, headers: HeaderMap) -> Response {
    let app = state.lock().unwrap();
    if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(|v| v.strip_prefix("Bearer ").unwrap_or(v)) != Some(app.token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({ "repo": app.repo.to_string_lossy(), "threads": app.threads.len() })).into_response()
}

fn open_browser(url: &str) {
    let attempts: Vec<Vec<&str>> = if cfg!(target_os = "windows") {
        vec![vec!["cmd", "/c", "start", "", url], vec!["explorer", url]]
    } else if cfg!(target_os = "macos") {
        vec![vec!["open", url]]
    } else {
        vec![vec!["xdg-open", url]]
    };
    for args in attempts {
        if Command::new(args[0]).args(&args[1..]).spawn().is_ok() { return; }
    }
    println!("Could not open a browser automatically. Open {url}");
}


fn version_newer(latest: &str, current: &str) -> bool {
    let parts = |value: &str| value.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let a = parts(latest);
    let b = parts(current);
    for i in 0..a.len().max(b.len()) {
        let left = a.get(i).copied().unwrap_or(0);
        let right = b.get(i).copied().unwrap_or(0);
        if left > right { return true; }
        if left < right { return false; }
    }
    false
}

fn release_asset() -> &'static str {
    if cfg!(target_os = "windows") {
        "diffloop-windows-x64.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "diffloop-darwin-arm64" } else { "diffloop-darwin-x64" }
    } else if cfg!(target_arch = "aarch64") {
        "diffloop-linux-arm64"
    } else {
        "diffloop-linux-x64"
    }
}

#[cfg(unix)]
fn mark_executable(staged: &FsPath, target: &FsPath) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(target)
        .map(|meta| meta.permissions().mode() & 0o777)
        .unwrap_or(0o755);
    let mode = if mode & 0o111 == 0 { 0o755 } else { mode };
    fs::set_permissions(staged, fs::Permissions::from_mode(mode))
}

#[cfg(windows)]
fn schedule_windows_replace(target: &FsPath, staged: &FsPath) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let escape = |value: &str| value.replace('\'', "''");
    let process = target.file_stem().and_then(|name| name.to_str()).unwrap_or("diffloop");
    let script = format!(
        "Start-Sleep -Milliseconds 800; while (Get-Process -Name '{}' -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 250 }}; for ($i = 0; $i -lt 120; $i++) {{ try {{ Move-Item -Force -LiteralPath '{}' -Destination '{}' -ErrorAction Stop; break }} catch {{ Start-Sleep -Milliseconds 250 }} }}",
        escape(process),
        escape(&staged.to_string_lossy()),
        escape(&target.to_string_lossy()),
    );
    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command"])
        .arg(script)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map(|_| ())
}

fn upgrade(check_only: bool) -> bool {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let body = match ureq::get(&url).header("User-Agent", "diffloop-upgrade").call()
        .and_then(|r| r.into_body().read_to_string()) {
        Ok(body) => body,
        Err(e) => { eprintln!("upgrade failed: {e}"); return false; }
    };
    let release: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(error) => { eprintln!("upgrade failed: could not parse release metadata: {error}"); return false; }
    };
    let tag = release.get("tag_name").and_then(Value::as_str).unwrap_or("");
    let latest = tag.trim_start_matches('v');
    if latest == VERSION || !version_newer(latest, VERSION) {
        println!("diffloop {VERSION} is up to date (latest {tag}).");
        return true;
    }
    if check_only {
        println!("diffloop {tag} is available (installed {VERSION}).");
        return true;
    }
    let asset = release_asset();
    let download = release.get("assets").and_then(Value::as_array)
        .and_then(|assets| assets.iter().find(|a| a.get("name").and_then(Value::as_str) == Some(asset)))
        .and_then(|a| a.get("browser_download_url").and_then(Value::as_str));
    let Some(url) = download else { eprintln!("no asset for this platform"); return false; };
    println!("Upgrading diffloop {VERSION} -> {tag} ({asset})...");
    let bytes = match ureq::get(url).call().and_then(|r| r.into_body().with_config().limit(200_000_000).read_to_vec()) {
        Ok(bytes) => bytes,
        Err(e) => { eprintln!("download failed: {e}"); return false; }
    };
    let target = match env::current_exe() {
        Ok(path) => path,
        Err(error) => { eprintln!("upgrade failed: cannot locate the current executable: {error}"); return false; }
    };
    let staged = if cfg!(windows) {
        target.with_file_name(format!("diffloop-new-{}.exe", std::process::id()))
    } else {
        target.with_file_name(format!(".diffloop-new-{}", std::process::id()))
    };
    if let Err(error) = fs::write(&staged, &bytes) {
        let _ = fs::remove_file(&staged);
        eprintln!("upgrade failed: could not write {}: {error}", staged.display());
        if !cfg!(windows) { eprintln!("Re-run with sudo if diffloop is installed in a system directory, or reinstall with install.sh."); }
        return false;
    }
    #[cfg(unix)]
    {
        if let Err(error) = mark_executable(&staged, &target) {
            let _ = fs::remove_file(&staged);
            eprintln!("upgrade failed: could not mark {} executable: {error}", staged.display());
            return false;
        }
    }
    let expected = format!("diffloop {latest}");
    match Command::new(&staged).arg("--version").output() {
        Ok(output) if output.status.success()
            && String::from_utf8_lossy(&output.stdout).trim() == expected => {}
        Ok(output) => {
            let reported = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let _ = fs::remove_file(&staged);
            eprintln!("upgrade failed: downloaded binary reported {reported:?}, expected {expected:?}");
            return false;
        }
        Err(error) => {
            let _ = fs::remove_file(&staged);
            eprintln!("upgrade failed: downloaded binary did not start: {error}");
            return false;
        }
    }
    #[cfg(windows)]
    {
        match schedule_windows_replace(&target, &staged) {
            Ok(()) => {
                println!("Upgrade staged. It will replace {} after diffloop exits.", target.display());
                return true;
            }
            Err(error) => {
                eprintln!("upgrade failed: could not start the replacement helper: {error}");
                eprintln!("Close diffloop, then move {} to {}.", staged.display(), target.display());
                return false;
            }
        }
    }
    #[cfg(not(windows))]
    {
        match fs::rename(&staged, &target) {
            Ok(()) => {
                println!("Upgraded to {tag}. Restart any running diffloop windows.");
                true
            }
            Err(error) => {
                eprintln!("upgrade failed: could not replace {}: {error}", target.display());
                eprintln!("The new binary is at {}. Move it into place manually or reinstall.", staged.display());
                false
            }
        }
    }
}

fn print_grammars() {
    let downloadable: Vec<(&str, Vec<&str>)> = vec![
        ("tree-sitter-c_sharp.wasm", vec![".cs"]),
        ("tree-sitter-go.wasm", vec![".go"]),
        ("tree-sitter-rust.wasm", vec![".rs"]),
        ("tree-sitter-python.wasm", vec![".py"]),
        ("tree-sitter-java.wasm", vec![".java"]),
        ("tree-sitter-c.wasm", vec![".c", ".h"]),
        ("tree-sitter-cpp.wasm", vec![".cc", ".cpp", ".cxx", ".hpp"]),
        ("tree-sitter-ruby.wasm", vec![".rb"]),
        ("tree-sitter-php.wasm", vec![".php"]),
        ("tree-sitter-scala.wasm", vec![".scala"]),
        ("tree-sitter-dart.wasm", vec![".dart"]),
        ("tree-sitter-elixir.wasm", vec![".ex", ".exs"]),
        ("tree-sitter-haskell.wasm", vec![".hs"]),
        ("tree-sitter-ocaml.wasm", vec![".ml"]),
        ("tree-sitter-solidity.wasm", vec![".sol"]),
        ("tree-sitter-svelte.wasm", vec![".svelte"]),
        ("tree-sitter-bash.wasm", vec![".sh", ".bash"]),
        ("tree-sitter-toml.wasm", vec![".toml"]),
    ];
    let embedded: Vec<(&str, Vec<&str>)> = vec![
        ("tree-sitter-javascript.wasm", vec![".js", ".jsx", ".mjs", ".cjs"]),
        ("tree-sitter-typescript.wasm", vec![".ts"]),
        ("tree-sitter-tsx.wasm", vec![".tsx"]),
        ("tree-sitter-html.wasm", vec![".html", ".htm"]),
        ("tree-sitter-css.wasm", vec![".css", ".scss"]),
        ("tree-sitter-json.wasm", vec![".json"]),
        ("tree-sitter-perl.wasm", vec![".pl", ".pm"]),
        ("tree-sitter-SQL.wasm", vec![".sql"]),
        ("tree-sitter-xml.wasm", vec![".xml", ".svg", ".xsd", ".xsl"]),
        ("tree-sitter-markdown.wasm", vec![".md"]),
        ("tree-sitter-vue.wasm", vec![".vue"]),
        ("tree-sitter-yaml.wasm", vec![".yaml", ".yml"]),
    ];
    let mut rows: Vec<[String; 5]> = Vec::new();
    for (index, (file, extensions)) in downloadable.iter().chain(embedded.iter()).enumerate() {
        let cached = home().join(".cache/diffloop/grammars").join(file).exists();
        let embedded_flag = index >= downloadable.len();
        let exts = format!("[ {} ]", extensions.iter().map(|e| format!("\"{e}\"")).collect::<Vec<_>>().join(", "));
        rows.push([
            index.to_string(),
            file.to_string(),
            exts,
            embedded_flag.to_string(),
            cached.to_string(),
        ]);
    }
    let headers = ["", "file", "extensions", "embedded", "cached"];
    let mut widths = headers.map(str::len);
    for row in &rows {
        for i in 0..5 { widths[i] = widths[i].max(row[i].len()); }
    }
    let border = |left: char, mid: char, right: char| {
        let mut line = String::new();
        line.push(left);
        for (i, width) in widths.iter().enumerate() {
            line.push_str(&"─".repeat(width + 2));
            line.push(if i == 4 { right } else { mid });
        }
        line
    };
    println!("{}", border('┌', '┬', '┐'));
    let print_row = |cells: [&str; 5]| {
        let mut line = String::new();
        for (i, cell) in cells.iter().enumerate() {
            line.push_str("│ ");
            if i == 0 { line.push_str(&format!("{:>width$}", cell, width = widths[i])); }
            else { line.push_str(&format!("{:<width$}", cell, width = widths[i])); }
            line.push(' ');
        }
        println!("{line}│");
    };
    print_row(headers);
    println!("{}", border('├', '┼', '┤'));
    for row in &rows {
        print_row([&row[0], &row[1], &row[2], &row[3], &row[4]]);
    }
    println!("{}", border('└', '┴', '┘'));
}

fn print_help() {
    println!("diffloop {VERSION}\n\nUsage:\n  diffloop --repo <path> [--base <ref>] [--port <n>] [--no-open]\n  diffloop comments [--json] [--repo <path>]\n  diffloop comment add --path <file> --line <n> --body \"note\"\n  diffloop comment note <id> --body \"note\"\n  diffloop resolve <id> --reply \"done\"\n  diffloop sessions\n  diffloop grammars\n  diffloop upgrade [--check]");
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if has(&args, "version") || args.iter().any(|a| a == "-v") {
        println!("diffloop {VERSION}");
        return;
    }
    if has(&args, "help") || args.iter().any(|a| a == "-h") {
        print_help();
        return;
    }
    let command = args.first().filter(|a| !a.starts_with('-')).cloned().unwrap_or_else(|| "serve".into());
    let rest: Vec<String> = if args.first().map(String::as_str) == Some(command.as_str()) {
        args.iter().skip(1).cloned().collect()
    } else { args.clone() };
    if has(&rest, "repo") && flag(&rest, "repo").is_none() {
        eprintln!("--repo needs a path");
        std::process::exit(1);
    }

    match command.as_str() {
        "serve" => {
            let repo = target_repo(&rest);
            let base = flag(&rest, "base").unwrap_or_else(|| "HEAD".into());
            let port = flag(&rest, "port").and_then(|p| p.parse::<u16>().ok()).unwrap_or(0);
            let token = new_token();
            let signature = repo_signature(&repo, &base);
            let patch = build_patch(&repo, &base);
            let threads = load_threads(&repo);
            let (state, stamps) = derive_state(&repo, &patch, &base);
            log(format!("watching {} · base {base} · {} file(s)", repo.display(), changed_paths(&patch).len()));
            log(format!("state {}", threads_path(&repo).display()));
            let app = Arc::new(Mutex::new(App { repo: repo.clone(), base: base.clone(), patch, signature, token: token.clone(), threads, state, stamps }));
            let _ = EVENTS.set(tokio::sync::broadcast::channel(32).0);
            let router = Router::new()
                .route("/", get(index))
                .route("/app.js", get(app_js))
                .route("/app.css", get(app_css))
                .route("/api/state", get(api_state))
                .route("/api/events", get(api_events))
                .route("/api/branches", get(api_branches))
                .route("/api/base", post(api_base))
                .route("/api/threads", get(api_threads_list).post(api_threads))
                .route("/api/threads/{id}/{action}", post(api_thread_action))
                .route("/ctl/threads", axum::routing::get(ctl_threads).post(ctl_threads))
                .route("/ctl/threads/{id}/{action}", post(ctl_thread_action))
                .route("/ctl/status", get(ctl_status))
                .with_state(app.clone());
            watch_repo(app.clone());
            let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
            let bound = listener.local_addr().unwrap().port();
            let mut registry = read_registry();
            registry.insert(repo.to_string_lossy().to_string(), json!({
                "port": bound, "token": token, "repo": repo.to_string_lossy(), "base": base,
            }));
            write_registry(&registry);
            println!("diffloop serving {}\nhttp://127.0.0.1:{bound}", repo.display());
            if !has(&rest, "no-open") {
                open_browser(&format!("http://127.0.0.1:{bound}"));
            }
            axum::serve(listener, router).await.unwrap();
        }
        "comments" => {
            let repo = target_repo(&rest);
            let threads = match control(&repo, "/ctl/threads", "GET", None) {
                Ok(value) => value,
                Err(e) => { eprintln!("{e}"); return; }
            };
            if has(&rest, "json") {
                println!("{}", serde_json::to_string_pretty(&threads).unwrap_or_default());
            } else {
                let list: Vec<Thread> = serde_json::from_value(threads).unwrap_or_default();
                if list.is_empty() { println!("No open review threads."); }
                for thread in &list {
                    let last = thread.messages.last().map(|m| m.body.as_str()).unwrap_or("");
                    println!("{}  {}:{}  [{}] round {}", thread.id, thread.path, thread.line, thread.status, thread.round);
                    println!("    {}", last.replace('\n', "\n    "));
                }
                println!("\n{} open thread(s). Reply with: diffloop resolve <id> --reply \"done\"", list.len());
            }
        }
        "comment" => {
            let repo = target_repo(&rest);
            let action = rest.first().map(String::as_str).unwrap_or("");
            if action == "add" {
                let body = json!({
                    "path": flag(&rest, "path").unwrap_or_default(),
                    "line": flag(&rest, "line").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
                    "body": flag(&rest, "body").unwrap_or_default(),
                    "side": flag(&rest, "side").unwrap_or_else(|| "additions".into()),
                });
                match control(&repo, "/ctl/threads", "POST", Some(body)) {
                    Ok(t) => println!("added {} ({}:{})", t.get("id").and_then(Value::as_str).unwrap_or(""),
                        t.get("path").and_then(Value::as_str).unwrap_or(""),
                        t.get("line").and_then(Value::as_u64).unwrap_or(0)),
                    Err(e) => eprintln!("{e}"),
                }
            } else if action == "note" {
                let id = rest.get(1).cloned().unwrap_or_default();
                let path = format!("/ctl/threads/{id}/note");
                match control(&repo, &path, "POST", Some(json!({ "body": flag(&rest, "body").unwrap_or_default() }))) {
                    Ok(_) => println!("noted {id}"),
                    Err(e) => eprintln!("{e}"),
                }
            } else { eprintln!("usage: diffloop comment add|note ..."); }
        }
        "resolve" => {
            let repo = target_repo(&rest);
            let id = rest.first().cloned().unwrap_or_default();
            let path = format!("/ctl/threads/{id}/resolve");
            match control(&repo, &path, "POST", Some(json!({ "reply": flag(&rest, "reply").unwrap_or_default() }))) {
                Ok(t) => println!("resolved {} ({}:{})", t.get("id").and_then(Value::as_str).unwrap_or(""),
                    t.get("path").and_then(Value::as_str).unwrap_or(""),
                    t.get("line").and_then(Value::as_u64).unwrap_or(0)),
                Err(e) => eprintln!("{e}"),
            }
        }
        "sessions" => {
            let sessions = read_registry();
            if sessions.is_empty() { println!("No diffloop sessions running."); }
            for (repo, info) in sessions {
                println!("{}\t{}\tbase={}", repo,
                    info.get("port").and_then(Value::as_u64).unwrap_or(0),
                    info.get("base").and_then(Value::as_str).unwrap_or("HEAD"));
            }
        }
        "status" => {
            let repo = target_repo(&rest);
            match control(&repo, "/ctl/status", "GET", None) {
                Ok(value) => println!("{}", serde_json::to_string(&value).unwrap_or_default()),
                Err(e) => eprintln!("{e}"),
            }
        }
        "grammars" => print_grammars(),
        "upgrade" => if !upgrade(has(&rest, "check")) { std::process::exit(1); },
        _ => eprintln!("unknown command {command}"),
    }
}
