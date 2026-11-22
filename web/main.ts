import { CodeView, parsePatchFiles } from "@pierre/diffs";

type Side = "additions" | "deletions";
type Status = "open" | "sent" | "resolved" | "dismissed" | "stale";
interface Message { id: string; author: "you" | "agent"; body: string; at: string }
interface Thread {
  id: string; path: string; side: Side; line: number; anchor: string;
  messages: Message[]; status: Status; round: number; createdAt: string; updatedAt: string;
}
interface FunctionContext {
  id: string; path: string; name: string; startLine: number; endLine: number;
  header: string; firstLines: string[]; fullText: string; changedLines: number[];
  level: "function" | "block"; kind: string; extraLines: number[];
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const diffHost = $("#diff");
const treeHost = $("#file-tree");
const statsBody = $("#stats-body");
const fileSearch = $<HTMLInputElement>("#file-search");
const sourceInput = $<HTMLInputElement>("#source");
const baseInput = $<HTMLInputElement>("#base");
const baseList = document.querySelector<HTMLDataListElement>("#base-branches")!;

let threads: Thread[] = [];
let functions: FunctionContext[] = [];
let patch = "";
let version = 0;
let collapsed = false;
let theme: "pierre-light" | "pierre-dark" = "pierre-light";
let split = true;
let draft: { path: string; side: Side; line: number; anchor: string } | null = null;
let selectedFile: string | null = null;
const itemsById = new Map<string, any>();
const fileDiffs = new Map<string, any>();

const viewerOptions: Record<string, any> = {
  theme,
  stickyHeaders: true,
  enableGutterUtility: true,
  enableLineSelection: true,
  onSelectedLinesChange(selection: any) {
    const id = selection?.id ?? selection?.itemId;
    const range = selection?.range ?? selection;
    if (!id || !range || range.start !== range.end) return;
    const path = String(id).replace(/^diff:/, "");
    const fileDiff = fileDiffs.get(path);
    if (!fileDiff) return;
    const side: Side = range.side ?? "additions";
    draft = { path, side, line: range.start, anchor: anchorFor(fileDiff, side, range.start) };
    renderDiff();
  },
  diffStyle: "split",
  layout: { paddingTop: 16, paddingBottom: 16, gap: 12 },
  onGutterUtilityClick(range: any, context: any) {
    const item = context?.item;
    if (item?.type !== "diff" || !range) return;
    const side: Side = range.side ?? "additions";
    const line = range.start;
    draft = {
      path: item.fileDiff.name as string,
      side,
      line,
      anchor: anchorFor(item.fileDiff, side, line),
    };
    renderDiff();
  },
  renderAnnotation(annotation: any) {
    const thread = threads.find((t) => t.id === annotation.metadata?.threadId);
    if (thread) return threadCard(thread);
    if (annotation.metadata?.draft) return draftCard();
    return document.createElement("div");
  },
};

const viewer = new CodeView(viewerOptions);
viewer.setup(diffHost);

function anchorFor(fileDiff: any, side: Side, line: number): string {
  const lines = side === "additions" ? fileDiff.additionLines : fileDiff.deletionLines;
  if (!Array.isArray(lines)) return "";
  for (const hunk of fileDiff.hunks ?? []) {
    const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    const base = side === "additions" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    if (start == null || base == null || line < start || line >= start + count) continue;
    return String(lines[base + (line - start)] ?? "").replace(/\n$/, "");
  }
  return "";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function renderTree() {
  treeHost.replaceChildren();
  const query = fileSearch.value.trim().toLowerCase();
  const paths = [...fileDiffs.keys()].filter((path) => path.toLowerCase().includes(query));
  const root: any = {};
  for (const path of paths) {
    let node = root;
    const parts = path.split("/");
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part];
    }
    node[parts.at(-1)!] = { file: path };
  }
  const add = (node: any, parent: HTMLElement, prefix = "") => {
    const list = el("ul");
    for (const [name, value] of Object.entries(node)) {
      const item = el("li");
      const row = el("div", "row");
      const isFile = !!(value as any).file;
      if (isFile) {
        const fileDiff = fileDiffs.get((value as any).file);
        const type = fileDiff?.type;
        const status = type === "new" ? "A" : type === "deleted" ? "D" : type?.startsWith("rename") ? "R" : "M";
        const statusClass = status === "M" ? "modified" : status === "D" ? "deleted" : status === "R" ? "renamed" : "";
        row.append(
          el("span", "folder-toggle", ""),
          el("span", "icon", "•"),
          el("span", "name", name),
          el("span", `status ${statusClass}`, status),
        );
        if ((value as any).file === selectedFile) row.classList.add("selected");
        row.addEventListener("click", () => {
          selectedFile = (value as any).file;
          renderTree();
          viewer.scrollTo({ type: "item", id: `diff:${selectedFile}`, align: "start" });
        });
      } else {
        row.append(el("span", "folder-toggle", "▾"), el("span", "icon", ""), el("span", "name", name));
      }
      item.append(row);
      if (!isFile) item.append(add(value as any, item, `${prefix}${name}/`));
      list.append(item);
    }
    parent.append(list);
    return list;
  };
  add(root, treeHost);
}

function renderStats(stats: { files: number; additions: number; deletions: number }) {
  const line = (label: string, value: number, cls = "") => {
    const row = el("div", `stat-line ${cls}`);
    row.append(el("span", "", label), el("span", "", value.toLocaleString()));
    return row;
  };
  statsBody.replaceChildren(
    line("Files", stats.files),
    line("Additions", stats.additions, "add"),
    line("Deletions", stats.deletions, "del"),
    line("Review threads", threads.length),
  );
}

function draftCard(): HTMLElement {
  const card = el("div", "thread draft");
  const head = el("div", "thread-head");
  head.append(el("span", "path", `${draft?.path}:${draft?.line}`), el("span", "chip status-open", "new"));
  const input = el("textarea");
  input.placeholder = "What should the agent change here?";
  const actions = el("div", "thread-actions");
  const submit = el("button", "accent", "Add comment");
  const cancel = el("button", "", "Cancel");
  actions.append(submit, cancel);
  card.append(head, el("div", "anchor", draft?.anchor.trim() ?? ""), input, actions);
  queueMicrotask(() => input.focus());
  submit.addEventListener("click", async () => {
    const body = input.value.trim();
    if (!body || !draft) return;
    await post("/api/threads", { ...draft, body });
    draft = null;
    await refresh();
  });
  cancel.addEventListener("click", () => {
    draft = null;
    renderDiff();
  });
  return card;
}

function threadCard(thread: Thread): HTMLElement {
  const card = el("div", "thread inline-thread");
  card.dataset.thread = thread.id;
  const head = el("div", "thread-head");
  head.append(
    el("span", "path", `${thread.path}:${thread.line}`),
    el("span", `chip status-${thread.status}`, `r${thread.round} · ${thread.status}`),
  );
  card.append(head);
  if (thread.anchor.trim()) card.append(el("div", "anchor", thread.anchor.trim()));
  for (const msg of thread.messages) {
    const node = el("div", `msg ${msg.author}`);
    node.append(el("span", "who", msg.author === "you" ? "you" : "agent"), document.createTextNode(msg.body));
    card.append(node);
  }
  const input = el("textarea");
  input.placeholder = thread.status === "resolved" ? "Disagree? Reply to reopen" : "Reply to the agent";
  input.style.display = "none";
  const actions = el("div", "thread-actions");
  const replyButton = el("button", "", thread.status === "resolved" ? "Reopen" : "Reply");
  const sendButton = el("button", "accent", "Send to agent");
  const dismissButton = el("button", "", "Dismiss");
  actions.append(replyButton, sendButton, dismissButton);
  card.append(input, actions);
  replyButton.addEventListener("click", async () => {
    if (input.style.display === "none") {
      input.style.display = "block";
      input.focus();
      return;
    }
    const body = input.value.trim();
    if (!body) return;
    await post(`/api/threads/${thread.id}/reply`, { body });
    await refresh();
  });
  sendButton.addEventListener("click", async () => {
    await post(`/api/threads/${thread.id}/send`, {});
    await refresh();
  });
  dismissButton.addEventListener("click", async () => {
    await post(`/api/threads/${thread.id}/dismiss`, {});
    await refresh();
  });
  return card;
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function renderDiff() {
  fileDiffs.clear();
  const files = parsePatchFiles(patch, { cacheKeyPrefix: "diffloop" }).flatMap((p) => p.files);
  for (const file of files) fileDiffs.set(file.name, file);
  const ids = new Set(files.map((f) => `diff:${f.name}`));
  for (const id of [...itemsById.keys()]) {
    if (!ids.has(id)) {
      viewer.removeItem(id);
      itemsById.delete(id);
    }
  }
  for (const file of files) {
    const id = `diff:${file.name}`;
    const annotations: any[] = threads
      .filter((t) => t.path === file.name && t.status !== "dismissed")
      .map((t) => ({ side: t.side, lineNumber: t.line, metadata: { threadId: t.id } }));
    if (draft && draft.path === file.name) {
      annotations.push({ side: draft.side, lineNumber: draft.line, metadata: { draft: true } });
    }
    const previous = itemsById.get(id);
    const item = {
      id, type: "diff", fileDiff: file, annotations, collapsed,
      version: previous ? (previous.version ?? 0) + 1 : version++,
    };
    if (previous) viewer.updateItem(item);
    else viewer.addItem(item);
    itemsById.set(id, item);
  }
}

async function refresh() {
  const response = await fetch("/api/state");
  const state = (await response.json()) as {
    repo: string; base: string; patch: string; threads: Thread[]; functions: FunctionContext[];
    stats: { files: number; additions: number; deletions: number };
  };
  sourceInput.value = state.repo;
  if (document.activeElement !== baseInput) baseInput.value = state.base;
  patch = state.patch;
  threads = state.threads;
  functions = state.functions ?? [];
  renderDiff();
  renderTree();
  renderStats(state.stats);
}

fileSearch.addEventListener("input", renderTree);

async function applyBase() {
  const base = baseInput.value.trim() || "HEAD";
  try {
    const result = await post("/api/base", { base }) as { base: string };
    baseInput.value = result.base;
    await refresh();
  } catch (error) {
    window.alert(String(error));
    await refresh();
  }
}
$("#base-apply").addEventListener("click", () => void applyBase());
baseInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void applyBase();
});
fetch("/api/branches")
  .then((response) => response.json())
  .then((data: { branches: string[] }) => {
    baseList.replaceChildren(...data.branches.map((branch) => {
      const option = document.createElement("option");
      option.value = branch;
      return option;
    }));
  });
$("#refresh")?.addEventListener("click", () => void refresh());
$("#send-all").addEventListener("click", async () => {
  for (const thread of threads.filter((t) => t.status === "open" || t.status === "stale")) {
    await post(`/api/threads/${thread.id}/send`, {});
  }
  await refresh();
});
$("#layout-toggle").addEventListener("click", () => {
  split = !split;
  viewerOptions.diffStyle = split ? "split" : "unified";
  viewer.setOptions(viewerOptions);
  $("#layout-toggle").title = split ? "Switch to unified view" : "Switch to split view";
});
$("#collapse-all").addEventListener("click", () => {
  collapsed = !collapsed;
  for (const [id, item] of itemsById) {
    viewer.updateItem({ ...item, collapsed, version: (item.version ?? 0) + 1 });
    itemsById.set(id, { ...item, collapsed, version: (item.version ?? 0) + 1 });
  }
  $("#collapse-all").textContent = collapsed ? "Expand all files" : "Collapse all files";
});
$("#theme-toggle").addEventListener("click", () => {
  theme = theme === "pierre-light" ? "pierre-dark" : "pierre-light";
  document.documentElement.dataset.theme = theme === "pierre-light" ? "light" : "dark";
  viewerOptions.theme = theme;
  viewer.setOptions(viewerOptions);
});
$("#search-toggle").addEventListener("click", () => fileSearch.focus());
$("#stats-toggle").addEventListener("click", () => statsBody.classList.toggle("hidden"));

const gutterAdd = $<HTMLButtonElement>("#gutter-add");
let hideGutterTimer: ReturnType<typeof setTimeout> | null = null;

function pathForLine(line: HTMLElement): string | null {
  const rect = line.getBoundingClientRect();
  let best: { path: string; y: number } | null = null;
  const walk = (root: ParentNode) => {
    for (const node of root.querySelectorAll("*")) {
      if ((node as HTMLElement).shadowRoot) walk((node as HTMLElement).shadowRoot!);
      if (node.children.length > 0) continue;
      const text = (node.textContent ?? "").trim();
      if (!fileDiffs.has(text)) continue;
      const top = node.getBoundingClientRect().top;
      if (top <= rect.top && (!best || top > best.y)) best = { path: text, y: top };
    }
  };
  walk(document);
  return best?.path ?? null;
}

function lineAt(clientX: number, clientY: number): HTMLElement | null {
  const host = diffHost.getBoundingClientRect();
  if (clientX < host.left || clientX > host.right || clientY < host.top || clientY > host.bottom) return null;
  let best: { line: HTMLElement; distance: number } | null = null;
  const walk = (root: ParentNode) => {
    for (const node of root.querySelectorAll("[data-line]")) {
      const line = node as HTMLElement;
      const rect = line.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const distance = Math.min(Math.abs(clientX - rect.left), Math.abs(clientX - rect.right));
      if (!best || distance < best.distance) best = { line, distance };
    }
    for (const node of root.querySelectorAll("*")) {
      const shadow = (node as HTMLElement).shadowRoot;
      if (shadow) walk(shadow);
    }
  };
  walk(diffHost);
  return best?.line ?? null;
}

document.addEventListener("mousemove", (event) => {
  const line = lineAt(event.clientX, event.clientY);
  if (!line) {
    hideGutterTimer ??= setTimeout(() => gutterAdd.classList.remove("visible"), 200);
    return;
  }
  if (hideGutterTimer) clearTimeout(hideGutterTimer);
  hideGutterTimer = null;
  const rect = line.getBoundingClientRect();
  const path = pathForLine(line);
  if (!path) return;
  gutterAdd.dataset.path = path;
  gutterAdd.dataset.line = line.getAttribute("data-line") ?? "";
  gutterAdd.dataset.side = line.getAttribute("data-line-type")?.includes("deletion") ? "deletions" : "additions";
  gutterAdd.style.left = `${Math.max(0, rect.left - 24)}px`;
  gutterAdd.style.top = `${rect.top + (rect.height - 20) / 2}px`;
  gutterAdd.classList.add("visible");
});
gutterAdd.addEventListener("mouseenter", () => {
  if (hideGutterTimer) clearTimeout(hideGutterTimer);
});
gutterAdd.addEventListener("mouseleave", () => gutterAdd.classList.remove("visible"));
gutterAdd.addEventListener("click", () => {
  const path = gutterAdd.dataset.path;
  const line = Number(gutterAdd.dataset.line);
  const side: Side = gutterAdd.dataset.side === "deletions" ? "deletions" : "additions";
  const fileDiff = path ? fileDiffs.get(path) : null;
  if (!fileDiff || !line) return;
  draft = { path: path!, side, line, anchor: anchorFor(fileDiff, side, line) };
  renderDiff();
  gutterAdd.classList.remove("visible");
});

const events = new EventSource("/api/events");
events.onmessage = (event) => {
  const data = JSON.parse(event.data) as { type: string };
  if (data.type === "diff" || data.type === "threads") void refresh();
};

void refresh();
