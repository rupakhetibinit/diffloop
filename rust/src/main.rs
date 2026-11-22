use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path as FsPath, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const INDEX: &str = include_str!("../assets/index.html");
const APP_JS: &str = include_str!("../assets/app.js");
const APP_CSS: &str = include_str!("../assets/app.css");

#[derive(Clone, Serialize, Deserialize)]
struct Message {
    id: String,
    author: String,
    body: String,
    at: String,
}

#[derive(Clone, Serialize, Deserialize)]
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
    changed_lines: Vec<usize>,
    extra_lines: Vec<usize>,
}

struct App {
    repo: PathBuf,
    base: String,
    patch: String,
}

fn now() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis().to_string()
}

fn short_id() -> String {
    format!("{:08x}", now().parse::<u128>().unwrap_or(0) as u32 ^ (std::process::id() << 16))
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
            additions.push_str(&format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len()));
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

fn language_for(path: &str) -> Option<tree_sitter::Language> {
    let ext = path.rsplit('.').next().unwrap_or("");
    let language = match ext {
        "ts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "js" | "jsx" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "cs" => tree_sitter_c_sharp::LANGUAGE.into(),
        "py" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        _ => return None,
    };
    Some(language)
}

fn function_kind(kind: &str) -> bool {
    matches!(kind,
        "function_declaration" | "function_definition" | "function_item" | "method_declaration"
        | "class_declaration" | "struct_item" | "impl_item")
}

fn block_kind(kind: &str) -> bool {
    matches!(kind,
        "for_statement" | "for_in_statement" | "for_of_statement" | "for_expression"
        | "while_statement" | "while_expression"
        | "if_statement" | "if_expression" | "switch_statement" | "match_expression"
        | "try_statement" | "try_expression")
}

fn collect_scopes(repo: &FsPath, patch: &str, paths: &[String]) -> Vec<Scope> {
    let mut scopes = Vec::new();
    for path in paths {
        let Some(language) = language_for(path) else { continue };
        let contents = match fs::read_to_string(repo.join(path)) { Ok(c) => c, Err(_) => continue };
        let mut parser = tree_sitter::Parser::new();
        if parser.set_language(&language).is_err() { continue; }
        let Some(tree) = parser.parse(&contents, None) else { continue };
        let source: Vec<&str> = contents.lines().collect();
        let touched = changed_lines(patch, path);
        if touched.is_empty() { continue; }

        let mut stack = vec![tree.root_node()];
        while let Some(node) = stack.pop() {
            let kind = node.kind();
            let (level, relevant) = if function_kind(kind) {
                ("function", touched.iter().copied().filter(|line| {
                    *line >= node.start_position().row + 1 && *line <= node.end_position().row + 1
                }).collect::<Vec<_>>())
            } else if block_kind(kind) {
                ("block", touched.iter().copied().filter(|line| {
                    *line >= node.start_position().row + 1 && *line <= node.end_position().row + 1
                }).collect::<Vec<_>>())
            } else {
                ("", Vec::new())
            };
            if !level.is_empty() && !relevant.is_empty() {
                let start = node.start_position().row + 1;
                let end = node.end_position().row + 1;
                let header = source.get(start - 1).copied().unwrap_or("").trim().to_string();
                let name = node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(contents.as_bytes()).ok())
                    .unwrap_or(&header)
                    .split('\n').next().unwrap_or(kind)
                    .chars().take(80).collect();
                let mut extra = Vec::new();
                if kind == "try_statement" || kind == "try_expression" {
                    for child in node.children(&mut node.walk()) {
                        let ck = child.kind();
                        if ck == "catch_clause" || ck == "finally_clause" || ck == "except_clause" {
                            extra.push(child.start_position().row + 1);
                        }
                    }
                }
                if kind == "if_statement" || kind == "if_expression" {
                    for child in node.children(&mut node.walk()) {
                        if child.kind() == "else_clause" { extra.push(child.start_position().row + 1); }
                    }
                }
                scopes.push(Scope {
                    id: format!("{path}:{start}:{kind}"),
                    path: path.clone(), name, start_line: start, end_line: end,
                    level: level.to_string(), kind: kind.to_string(),
                    changed_lines: relevant, extra_lines: extra,
                });
            }
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) { stack.push(child); }
        }
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
        let mut ordered_scopes: Vec<&Scope> = scopes.iter().filter(|s| s.path == path && !s.changed_lines.is_empty()).collect();
        ordered_scopes.sort_by_key(|s| (s.start_line, if s.level == "function" { 0 } else { 1 }));
        for scope in ordered_scopes {
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
                for (start, text) in insertions.iter().filter(|(s, _)| *s < hunk_start) {
                    result.push_str(text);
                }
            }
            result.push_str(line);
            result.push('\n');
        }
    }
    result
}

fn threads_path(repo: &FsPath) -> PathBuf {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    repo.hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".local/share/diffloop").join(key).join("threads.json")
}

fn load_threads(repo: &FsPath) -> Vec<Thread> {
    fs::read_to_string(threads_path(repo))
        .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_threads(repo: &FsPath, threads: &[Thread]) {
    let path = threads_path(repo);
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    let _ = fs::write(path, serde_json::to_string_pretty(threads).unwrap_or_default());
}

fn state_response(app: &App) -> Value {
    let threads = load_threads(&app.repo);
    let scopes = collect_scopes(&app.repo, &app.patch, &changed_paths(&app.patch));
    let additions = app.patch.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
    let deletions = app.patch.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
    json!({
        "repo": app.repo.to_string_lossy(),
        "base": app.base,
        "patch": augment(&app.repo, &app.patch, &scopes, &app.base),
        "threads": threads,
        "functions": scopes,
        "stats": { "files": changed_paths(&app.patch).len(), "additions": additions, "deletions": deletions },
    })
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

async fn index() -> Html<&'static str> { Html(INDEX) }
async fn app_js() -> Response {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP_JS).into_response()
}
async fn app_css() -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], APP_CSS).into_response()
}

async fn api_state(State(state): State<Arc<Mutex<App>>>) -> Json<Value> {
    let app = state.lock().unwrap();
    Json(state_response(&app))
}

async fn api_branches(State(state): State<Arc<Mutex<App>>>) -> Json<Value> {
    let repo = state.lock().unwrap().repo.clone();
    let branches = git(&repo, &["branch", "--all", "--format=%(refname:short)"])
        .unwrap_or_default().lines().map(str::to_string).collect::<Vec<_>>();
    Json(json!({ "branches": branches }))
}

async fn api_base(State(state): State<Arc<Mutex<App>>>, Json(body): Json<Value>) -> Response {
    let base = body.get("base").and_then(Value::as_str).unwrap_or("HEAD").to_string();
    let mut app = state.lock().unwrap();
    if git(&app.repo, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    app.base = base.clone();
    app.patch = build_patch(&app.repo, &base);
    Json(json!({ "base": base })).into_response()
}

async fn api_threads(State(state): State<Arc<Mutex<App>>>, Json(body): Json<Value>) -> Response {
    let repo = state.lock().unwrap().repo.clone();
    let mut threads = load_threads(&repo);
    let path = body.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    let line = body.get("line").and_then(Value::as_u64).unwrap_or(0) as usize;
    let text = body.get("body").and_then(Value::as_str).unwrap_or("").to_string();
    if path.is_empty() || line == 0 || text.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let author = body.get("author").and_then(Value::as_str).unwrap_or("you").to_string();
    let anchor = working_lines(&repo, &path).get(line - 1).cloned().unwrap_or_default();
    let time = now();
    threads.push(Thread {
        id: short_id(), path, side: body.get("side").and_then(Value::as_str).unwrap_or("additions").to_string(),
        line, anchor, messages: vec![Message { id: short_id(), author, body: text, at: time.clone() }],
        status: "open".into(), round: 1, created_at: time.clone(), updated_at: time,
    });
    save_threads(&repo, &threads);
    Json(threads.last().unwrap().clone()).into_response()
}

async fn api_thread_action(
    State(state): State<Arc<Mutex<App>>>,
    Path((id, action)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    let repo = state.lock().unwrap().repo.clone();
    let mut threads = load_threads(&repo);
    let Some(thread) = threads.iter_mut().find(|t| t.id == id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let text = body.get("body").or_else(|| body.get("reply")).and_then(Value::as_str).unwrap_or("").to_string();
    match action.as_str() {
        "reply" | "note" | "resolve" => {
            if !text.is_empty() {
                thread.messages.push(Message { id: short_id(), author: "you".into(), body: text, at: now() });
            }
            if action == "resolve" { thread.status = "resolved".into(); }
            else if thread.status == "resolved" {
                thread.status = "open".into();
                thread.round += 1;
            }
        }
        "send" => if thread.status == "open" { thread.status = "sent".into() },
        "dismiss" => thread.status = if thread.status == "dismissed" { "open".into() } else { "dismissed".into() },
        _ => return StatusCode::NOT_FOUND.into_response(),
    }
    thread.updated_at = now();
    let result = thread.clone();
    save_threads(&repo, &threads);
    Json(result).into_response()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("serve");
    match command {
        "serve" => {
            let repo = args.windows(2).find(|w| w[0] == "--repo").map(|w| w[1].clone())
                .unwrap_or_else(|| ".".into());
            let repo = FsPath::new(&repo).canonicalize().unwrap_or_else(|_| FsPath::new(&repo).to_path_buf());
            let base = args.windows(2).find(|w| w[0] == "--base").map(|w| w[1].clone())
                .unwrap_or_else(|| "HEAD".into());
            let port = args.windows(2).find(|w| w[0] == "--port")
                .and_then(|w| w[1].parse::<u16>().ok()).unwrap_or(0);
            let patch = build_patch(&repo, &base);
            let app = Arc::new(Mutex::new(App { repo, base, patch }));
            let router = Router::new()
                .route("/", get(index))
                .route("/app.js", get(app_js))
                .route("/app.css", get(app_css))
                .route("/api/state", get(api_state))
                .route("/api/branches", get(api_branches))
                .route("/api/base", post(api_base))
                .route("/api/threads", post(api_threads))
                .route("/api/threads/{id}/{action}", post(api_thread_action))
                .with_state(app);
            let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            println!("diffloop-rs serving\nhttp://127.0.0.1:{port}");
            axum::serve(listener, router).await.unwrap();
        }
        "comments" => {
            let repo = FsPath::new(".").canonicalize().unwrap();
            for thread in load_threads(&repo).iter().filter(|t| ["open", "sent", "stale"].contains(&t.status.as_str())) {
                let last = thread.messages.last().map(|m| m.body.as_str()).unwrap_or("");
                println!("{}  {}:{}  [{}] round {}", thread.id, thread.path, thread.line, thread.status, thread.round);
                println!("    {}", last.replace('\n', "\n    "));
            }
        }
        _ => eprintln!("usage: diffloop-rs serve [--repo path] [--base ref] | comments"),
    }
}
