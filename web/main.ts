import {
  CodeView, parsePatchFiles,
  type CodeViewDiffItem, type CodeViewLineSelection, type CodeViewOptions,
  type DiffLineAnnotation, type FileDiffMetadata, type ThemesType,
} from "@pierre/diffs";

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
type AnnotationMeta = { threadId?: string; draft?: boolean };
type Annotation = DiffLineAnnotation<AnnotationMeta>;
type DiffItem = CodeViewDiffItem<AnnotationMeta>;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const diffHost = $("#diff");
const treeHost = $("#file-tree");
const statsBody = $("#stats-body");
const fileSearch = $<HTMLInputElement>("#file-search");
const sourceInput = $<HTMLInputElement>("#source");
const baseSelect = $<HTMLSelectElement>("#base");
const baseCustom = $<HTMLInputElement>("#base-custom");
const baseApply = $<HTMLButtonElement>("#base-apply");

let threads: Thread[] = [];
let functions: FunctionContext[] = [];
let patch = "";
let version = 0;
let collapsed = false;
let theme: "light" | "dark" = "light";
const themes: ThemesType = { light: "pierre-light", dark: "pierre-dark" };
let split = true;
let draft: { path: string; side: Side; line: number; anchor: string } | null = null;
let selectedFile: string | null = null;
let branches: string[] = [];
let currentBase = "HEAD";
let stats = { files: 0, additions: 0, deletions: 0 };
const itemsById = new Map<string, DiffItem>();
const fileDiffs = new Map<string, FileDiffMetadata>();
const cardsById = new Map<string, HTMLElement>();

const viewerOptions: CodeViewOptions<AnnotationMeta, undefined> = {
  theme: themes,
  themeType: theme,
  stickyHeaders: true,
  enableGutterUtility: true,
  enableLineSelection: true,
  onSelectedLinesChange(selection: CodeViewLineSelection | null) {
    if (!selection || selection.range.start !== selection.range.end) return;
    const range = selection.range;
    const path = String(selection.id).replace(/^diff:/, "");
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
  renderAnnotation(annotation: { metadata?: AnnotationMeta }) {
    const thread = threads.find((t) => t.id === annotation.metadata?.threadId);
    if (thread) {
      const card = threadCard(thread);
      cardsById.set(thread.id, card);
      return card;
    }
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

function renderStats() {
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
    const path = draft.path;
    await post("/api/threads", { ...draft, body });
    draft = null;
    updateAnnotations([path]);
    await loadThreads();
  });
  cancel.addEventListener("click", () => {
    draft = null;
    renderDiff();
  });
  return card;
}

function sendButtonState(status: Status) {
  if (status === "sent") return { label: "✓ Sent", disabled: true, sent: true };
  if (status === "resolved" || status === "dismissed") return { label: "Resolved", disabled: true, sent: true };
  return { label: "Send to agent", disabled: false, sent: false };
}

function fillThreadCard(card: HTMLElement, thread: Thread) {
  const oldInput = card.querySelector("textarea");
  const draftText = oldInput?.value ?? "";
  const replyOpen = oldInput != null && oldInput.style.display !== "none";
  const keepFocus = oldInput != null && document.activeElement === oldInput;
  card.replaceChildren();
  card.className = "thread inline-thread";
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
  input.style.display = replyOpen ? "block" : "none";
  input.value = draftText;
  const actions = el("div", "thread-actions");
  const replyButton = el("button", "", thread.status === "resolved" ? "Reopen" : "Reply");
  const sendState = sendButtonState(thread.status);
  const sendButton = el("button", sendState.sent ? "accent sent" : "accent", sendState.label);
  sendButton.disabled = sendState.disabled;
  const dismissButton = el("button", "", "Dismiss");
  actions.append(replyButton, sendButton, dismissButton);
  card.append(input, actions);
  replyButton.addEventListener("click", () => {
    if (input.style.display === "none") {
      input.style.display = "block";
      input.focus();
      return;
    }
    const body = input.value.trim();
    if (body) void threadAction(thread, "reply", body);
  });
  sendButton.addEventListener("click", () => void threadAction(thread, "send"));
  dismissButton.addEventListener("click", () => void threadAction(thread, "dismiss"));
  if (keepFocus) input.focus();
}

function threadCard(thread: Thread): HTMLElement {
  const card = el("div", "thread inline-thread");
  fillThreadCard(card, thread);
  return card;
}

function flashCard(card: HTMLElement) {
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 950);
}

function updateCardStatus(thread: Thread, flash = false) {
  const card = cardsById.get(thread.id);
  if (!card) return;
  const chip = card.querySelector<HTMLElement>(".chip");
  if (chip) {
    chip.className = `chip status-${thread.status}`;
    chip.textContent = `r${thread.round} · ${thread.status}`;
  }
  const send = card.querySelector<HTMLButtonElement>("button.accent");
  if (send) {
    const state = sendButtonState(thread.status);
    send.textContent = state.label;
    send.classList.toggle("sent", state.sent);
    send.disabled = state.disabled;
  }
  const reply = card.querySelector<HTMLButtonElement>(".thread-actions button");
  if (reply) reply.textContent = thread.status === "resolved" ? "Reopen" : "Reply";
  const input = card.querySelector<HTMLTextAreaElement>("textarea");
  if (input) input.placeholder = thread.status === "resolved" ? "Disagree? Reply to reopen" : "Reply to the agent";
  if (flash) flashCard(card);
}

function refreshCard(thread: Thread, flash = false) {
  const card = cardsById.get(thread.id);
  if (!card) return;
  fillThreadCard(card, thread);
  if (flash) flashCard(card);
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

type ThreadAction = "send" | "dismiss" | "reply" | "resolve";

function applyLocalAction(thread: Thread, action: ThreadAction, body = "") {
  const at = new Date().toISOString();
  if (action === "reply" || action === "resolve") {
    if (body) thread.messages.push({ id: `local-${at}`, author: "you", body, at });
    if (action === "resolve") thread.status = "resolved";
    else if (thread.status === "resolved") {
      thread.status = "open";
      thread.round += 1;
    }
  } else if (action === "send") {
    if (thread.status === "open" || thread.status === "stale") thread.status = "sent";
  } else {
    thread.status = thread.status === "dismissed" ? "open" : "dismissed";
  }
  thread.updatedAt = at;
}

function annotationsFor(path: string): Annotation[] {
  const annotations: Annotation[] = threads
    .filter((t) => t.path === path && t.status !== "dismissed")
    .map((t) => ({ side: t.side, lineNumber: t.line, metadata: { threadId: t.id } }));
  if (draft && draft.path === path) {
    annotations.push({ side: draft.side, lineNumber: draft.line, metadata: { draft: true } });
  }
  return annotations;
}

function updateAnnotations(paths: Iterable<string>, force = false) {
  const wanted = new Set(paths);
  for (const [id, item] of itemsById) {
    const path = id.replace(/^diff:/, "");
    if (!wanted.has(path)) continue;
    const annotations = annotationsFor(path);
    if (!force && JSON.stringify(annotations) === JSON.stringify(item.annotations)) continue;
    const updated = { ...item, annotations, version: (item.version ?? 0) + 1 };
    viewer.updateItem(updated);
    itemsById.set(id, updated);
  }
}

async function threadAction(thread: Thread, action: ThreadAction, body = "") {
  const previous = { ...thread, messages: [...thread.messages] };
  const changesAnchor = action === "dismiss" || previous.status === "dismissed";
  const statusOnly = action === "send";
  const paint = (flash = false) => statusOnly ? updateCardStatus(thread, flash) : refreshCard(thread, flash);
  applyLocalAction(thread, action, body);
  paint(true);
  if (changesAnchor) updateAnnotations([thread.path]);
  try {
    const updated = await post(`/api/threads/${thread.id}/${action}`, action === "reply" || action === "resolve" ? { body } : {}) as Thread;
    Object.assign(thread, updated);
    paint();
    if (changesAnchor) updateAnnotations([thread.path]);
  } catch (error) {
    Object.assign(thread, previous);
    paint();
    if (changesAnchor) updateAnnotations([thread.path]);
    console.error(error);
  }
}

async function loadThreads() {
  const response = await fetch("/api/threads");
  if (!response.ok) return;
  const previous = new Map(threads.map((t) => [t.id, t]));
  threads = await response.json() as Thread[];
  renderStats();
  const changedPaths = new Set<string>();
  for (const thread of threads) {
    const before = previous.get(thread.id);
    if (!before) {
      changedPaths.add(thread.path);
    } else if (before.path !== thread.path || before.line !== thread.line || before.side !== thread.side
      || (before.status === "dismissed") !== (thread.status === "dismissed")) {
      changedPaths.add(thread.path);
    } else if (JSON.stringify(before) !== JSON.stringify(thread)) {
      if (JSON.stringify(before.messages) === JSON.stringify(thread.messages)) updateCardStatus(thread);
      else refreshCard(thread);
    }
  }
  if (changedPaths.size) updateAnnotations(changedPaths);
}

function renderDiff() {
  fileDiffs.clear();
  cardsById.clear();
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
    const annotations = annotationsFor(file.name);
    const previous = itemsById.get(id);
    const item: DiffItem = {
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
  currentBase = state.base;
  if (document.activeElement !== baseCustom) updateBaseControl();
  patch = state.patch;
  threads = state.threads;
  functions = state.functions ?? [];
  stats = state.stats;
  renderDiff();
  renderTree();
  renderStats();
}

fileSearch.addEventListener("input", renderTree);

function updateBaseControl() {
  const refs = ["HEAD", ...branches.filter((ref) => ref !== "HEAD")];
  if (!refs.includes(currentBase)) refs.push(currentBase);
  baseSelect.replaceChildren(...[...refs, "__custom__"].map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "__custom__" ? "Other ref…" : value;
    return option;
  }));
  baseSelect.value = currentBase;
  baseCustom.value = "";
  baseCustom.classList.add("hidden");
  baseApply.classList.add("hidden");
}

async function applyBase(base: string) {
  const ref = base.trim() || "HEAD";
  try {
    const result = await post("/api/base", { base: ref }) as { base: string };
    currentBase = result.base;
    updateBaseControl();
    await refresh();
  } catch (error) {
    window.alert(String(error));
    await refresh();
  }
}

baseSelect.addEventListener("change", () => {
  if (baseSelect.value === "__custom__") {
    baseCustom.value = "";
    baseCustom.classList.remove("hidden");
    baseApply.classList.remove("hidden");
    baseCustom.focus();
    return;
  }
  baseCustom.classList.add("hidden");
  baseApply.classList.add("hidden");
  void applyBase(baseSelect.value);
});
baseApply.addEventListener("click", () => void applyBase(baseCustom.value));
baseCustom.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void applyBase(baseCustom.value);
});
fetch("/api/branches")
  .then((response) => response.json())
  .then((data: { branches: string[] }) => {
    branches = data.branches;
    updateBaseControl();
  });
$("#refresh")?.addEventListener("click", () => void refresh());
let sendAllTimer: ReturnType<typeof setTimeout> | null = null;
const sendAllButton = $("#send-all");
sendAllButton.addEventListener("click", () => {
  const targets = threads.filter((t) => t.status === "open" || t.status === "stale");
  if (!targets.length) return;
  for (const thread of targets) {
    applyLocalAction(thread, "send");
    updateCardStatus(thread, true);
  }
  sendAllButton.textContent = `✓ Sent ${targets.length}`;
  sendAllButton.classList.add("done");
  if (sendAllTimer) clearTimeout(sendAllTimer);
  sendAllTimer = setTimeout(() => {
    sendAllButton.textContent = "Send to agent";
    sendAllButton.classList.remove("done");
  }, 1500);
  void Promise.all(targets.map(async (thread) => {
    try {
      Object.assign(thread, await post(`/api/threads/${thread.id}/send`, {}));
      updateCardStatus(thread);
    } catch (error) {
      console.error(error);
    }
  })).then(() => renderStats());
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
  theme = theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  viewerOptions.themeType = theme;
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
  return (best as { path: string; y: number } | null)?.path ?? null;
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
  return (best as { line: HTMLElement; distance: number } | null)?.line ?? null;
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
  if (data.type === "diff") void refresh();
  else if (data.type === "threads") void loadThreads();
};

void refresh();
