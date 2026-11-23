import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { createRoot } from "react-dom/client";
import { createAgent } from "@ui-sdk/react/agent";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import {
  Select, SelectContent, SelectItem, SelectItemIndicator,
  SelectTrigger, SelectValue,
} from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { Toggle } from "@ui-sdk/react/toggle";
import {
  Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel,
  treeFromPaths, type TreeItemData,
} from "@ui-sdk/react/tree";
import { parsePatchFiles, type CodeViewLineSelection } from "@pierre/diffs";
import {
  CodeView, useStableCallback,
  type CodeViewDiffItem, type CodeViewHandle,
  type CodeViewReactOptions, type DiffLineAnnotation, type FileDiffMetadata,
  type ThemesType,
} from "@pierre/diffs/react";

type Side = "additions" | "deletions";
type Status = "open" | "sent" | "resolved" | "dismissed" | "stale";
type ThreadActionName = "send" | "dismiss" | "reply" | "resolve";
interface Message { id: string; author: "you" | "agent"; body: string; at: string }
interface Thread {
  id: string; path: string; side: Side; line: number; anchor: string;
  messages: Message[]; status: Status; round: number; createdAt: string; updatedAt: string;
}
interface Draft { path: string; side: Side; line: number; anchor: string }
interface Stats { files: number; additions: number; deletions: number }
interface State {
  repo: string; base: string; patch: string; threads: Thread[]; stats: Stats;
}
type AnnotationMeta = { threadId?: string; draft?: boolean };
type Annotation = DiffLineAnnotation<AnnotationMeta>;
type Item = CodeViewDiffItem<AnnotationMeta>;

const themes: ThemesType = { light: "pierre-light", dark: "pierre-dark" };

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<any>;
}

function anchorFor(file: FileDiffMetadata | undefined, side: Side, line: number): string {
  if (!file) return "";
  const lines = side === "additions" ? file.additionLines : file.deletionLines;
  if (!Array.isArray(lines)) return "";
  for (const hunk of file.hunks ?? []) {
    const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    const base = side === "additions" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    if (start == null || base == null || line < start || line >= start + count) continue;
    return String(lines[base + (line - start)] ?? "").replace(/\n$/, "");
  }
  return "";
}

function applyLocalAction(thread: Thread, action: ThreadActionName, body = "") {
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

function sendButtonLabel(status: Status) {
  if (status === "sent") return { label: "✓ Sent", disabled: true, sent: true };
  if (status === "resolved" || status === "dismissed") return { label: "Resolved", disabled: true, sent: true };
  return { label: "Send to agent", disabled: false, sent: false };
}

interface ReviewContextValue {
  threads: Thread[];
  draft: Draft | null;
  replyOpen: Record<string, boolean>;
  replyDrafts: Record<string, string>;
  setReplyOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setReplyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  threadAction(thread: Thread, action: ThreadActionName, body?: string): void;
  submitDraft(body: string): void;
}
const ReviewContext = createContext<ReviewContextValue | null>(null);
function useReview() {
  const value = useContext(ReviewContext);
  if (!value) throw new Error("missing review context");
  return value;
}

function ThreadCard({ threadId }: { threadId: string }) {
  const review = useReview();
  const thread = review.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  const send = sendButtonLabel(thread.status);
  const open = !!review.replyOpen[thread.id];
  const text = review.replyDrafts[thread.id] ?? "";
  return (
    <div className="thread inline-thread">
      <div className="thread-head">
        <span className="path">{thread.path}:{thread.line}</span>
        <span className={`chip status-${thread.status}`}>r{thread.round} · {thread.status}</span>
      </div>
      {thread.anchor.trim() && <div className="anchor">{thread.anchor.trim()}</div>}
      {thread.messages.map((msg) => (
        <div className={`msg ${msg.author}`} key={msg.id}>
          <span className="who">{msg.author === "you" ? "you" : "agent"}</span>
          {msg.body}
        </div>
      ))}
      {open && (
        <Textarea
          aria-label={`Reply to thread ${thread.id}`}
          value={text}
          placeholder={thread.status === "resolved" ? "Disagree? Reply to reopen" : "Reply to the agent"}
          onValueChange={(value) => review.setReplyDrafts((d) => ({ ...d, [thread.id]: value }))}
        />
      )}
      <div className="thread-actions">
        <Button onClick={() => {
          if (!open) {
            review.setReplyOpen((o) => ({ ...o, [thread.id]: true }));
            return;
          }
          if (!text.trim()) return;
          review.threadAction(thread, "reply", text.trim());
          review.setReplyDrafts((d) => ({ ...d, [thread.id]: "" }));
          review.setReplyOpen((o) => ({ ...o, [thread.id]: false }));
        }}>{thread.status === "resolved" ? "Reopen" : "Reply"}</Button>
        <Button
          className={send.sent ? "accent sent" : "accent"}
          disabled={send.disabled}
          onClick={() => review.threadAction(thread, "send")}
        >{send.label}</Button>
        <Button onClick={() => review.threadAction(thread, "dismiss")}>Dismiss</Button>
      </div>
    </div>
  );
}

function DraftCard() {
  const { draft, submitDraft } = useReview();
  const [text, setText] = useState("");
  if (!draft) return null;
  return (
    <div className="thread draft">
      <div className="thread-head">
        <span className="path">{draft.path}:{draft.line}</span>
        <span className="chip status-open">new</span>
      </div>
      <div className="anchor">{draft.anchor.trim()}</div>
      <Textarea
        autoFocus
        aria-label="New review comment"
        value={text}
        placeholder="What should the agent change here?"
        onValueChange={setText}
      />
      <div className="thread-actions">
        <Button className="accent" onClick={() => submitDraft(text.trim())}>Add comment</Button>
        <Button onClick={() => submitDraft("")}>Cancel</Button>
      </div>
    </div>
  );
}

function TreeRows({ items, byName }: { items: TreeItemData[]; byName: Map<string, FileDiffMetadata> }) {
  return items.map((item) => {
    const type = byName.get(item.value)?.type;
    const status = type === "new" ? "A" : type === "deleted" ? "D" : type?.startsWith("rename") ? "R" : "";
    const cls = status === "D" ? "deleted" : status === "R" ? "renamed" : "modified";
    return (
      <TreeItem key={item.value} value={item.value}>
        <TreeItemLabel className="tree-label">
          {item.children
            ? <TreeItemIndicator className="tree-indicator" aria-hidden="true">›</TreeItemIndicator>
            : <span className="icon">•</span>}
          <span className="name">{item.label}</span>
          {status && <span className={`status ${cls}`}>{status}</span>}
        </TreeItemLabel>
        {item.children && (
          <TreeGroup><TreeRows items={item.children} byName={byName} /></TreeGroup>
        )}
      </TreeItem>
    );
  });
}

function FileTree({ files, selected, query, expanded, onExpandedChange, onSelect }: {
  files: FileDiffMetadata[];
  selected: string | null;
  query: string;
  expanded: string[];
  onExpandedChange(value: string[]): void;
  onSelect(path: string): void;
}) {
  const byName = useMemo(() => new Map(files.map((file) => [file.name, file])), [files]);
  const paths = useMemo(
    () => files.map((file) => file.name).filter((name) => name.toLowerCase().includes(query.toLowerCase())),
    [files, query],
  );
  const items = useMemo(() => treeFromPaths(paths), [paths]);
  return (
    <Tree
      className="tree"
      aria-label="Changed files"
      paths={paths}
      items={items}
      value={selected}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      onValueChange={(value) => { if (typeof value === "string") onSelect(value); }}
    >
      <TreeRows items={items} byName={byName} />
    </Tree>
  );
}

function codeScrollBlocks(section: HTMLElement | null): HTMLElement[] {
  if (!section) return [];
  return [...section.querySelectorAll("diffs-container")].flatMap((host) => {
    const root = (host as HTMLElement).shadowRoot;
    return root ? [...root.querySelectorAll<HTMLElement>("[data-code]")] : [];
  });
}

function DiffScrollbar({ sectionRef, revision, layout }: {
  sectionRef: React.RefObject<HTMLElement | null>;
  revision: unknown;
  layout: string;
}) {
  const [position, setPosition] = useState(0);
  const [maxScroll, setMaxScroll] = useState(0);
  const [thumbWidth, setThumbWidth] = useState(80);
  const [visible, setVisible] = useState(false);
  const blocks = useRef<HTMLElement[]>([]);
  const bound = useRef(new WeakSet<HTMLElement>());
  const maxScrollRef = useRef(0);

  const syncFromScroll = useCallback((event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.matches?.("[data-code]")) return;
    const furthest = blocks.current.reduce((furthest, block) => Math.max(furthest, block.scrollLeft), 0);
    setPosition(Math.min(maxScrollRef.current, Math.max(0, furthest)));
  }, []);

  const measure = useCallback(() => {
    const section = sectionRef.current;
    if (!section) return;
    const found = codeScrollBlocks(section);
    blocks.current = found;
    for (const block of found) {
      if (!bound.current.has(block)) {
        block.addEventListener("scroll", syncFromScroll, { passive: true });
        bound.current.add(block);
      }
    }
    let content = 0;
    let viewport = 0;
    let max = 0;
    let furthest = 0;
    for (const block of found) {
      content = Math.max(content, block.scrollWidth);
      viewport = Math.max(viewport, block.clientWidth);
      max = Math.max(max, block.scrollWidth - block.clientWidth);
      furthest = Math.max(furthest, block.scrollLeft);
    }
    maxScrollRef.current = max;
    setMaxScroll(max);
    setPosition(Math.min(max, furthest));
    setVisible(max > 1);
    if (content > viewport) {
      const track = section.clientWidth;
      setThumbWidth(Math.max(48, Math.min(track, Math.round((viewport / content) * track))));
    }
  }, [sectionRef, syncFromScroll]);

  useEffect(() => {
    measure();
    const section = sectionRef.current;
    if (!section) return;
    const frame = requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 200);
    const observer = new MutationObserver(measure);
    observer.observe(section, { childList: true, subtree: true });
    const resize = new ResizeObserver(measure);
    resize.observe(section);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, revision, layout]);

  if (!visible) return null;
  const apply = (value: number) => {
    setPosition(value);
    const ordered = [...blocks.current].sort(
      (a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth),
    );
    for (const block of ordered) {
      const limit = block.scrollWidth - block.clientWidth;
      if (limit > 0) block.scrollLeft = Math.min(value, limit);
    }
  };
  return (
    <input
      type="range"
      className="diff-hscroll"
      min={0}
      max={Math.max(1, maxScroll)}
      step={1}
      value={position}
      aria-label="Scroll diff horizontally"
      style={{ "--thumb-width": `${thumbWidth}px` } as React.CSSProperties}
      onChange={(event) => apply(Number(event.currentTarget.value))}
    />
  );
}

function App() {
  const [data, setData] = useState<State | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseChoice, setBaseChoice] = useState("HEAD");
  const [customBase, setCustomBase] = useState(false);
  const [customRef, setCustomRef] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [replyOpen, setReplyOpen] = useState<Record<string, boolean>>({});
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [split, setSplit] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const viewer = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  const diffRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state");
    if (!response.ok) {
      console.warn(`[diffloop] state refresh failed (${response.status})`);
      return;
    }
    setData(await response.json() as State);
  }, []);

  const loadThreads = useCallback(async () => {
    const response = await fetch("/api/threads");
    if (!response.ok) return;
    const threads = await response.json() as Thread[];
    setData((current) => current ? { ...current, threads } : current);
  }, []);

  const loadBranches = useCallback(async () => {
    const response = await fetch("/api/branches");
    if (!response.ok) return;
    const { branches } = await response.json() as { branches: string[] };
    setBranches(branches);
  }, []);

  const replaceThread = useCallback((thread: Thread) => {
    setData((current) => current ? {
      ...current,
      threads: current.threads.map((t) => t.id === thread.id ? thread : t),
    } : current);
  }, []);

  const threadAction = useCallback(async (thread: Thread, action: ThreadActionName, body = "") => {
    const previous = { ...thread, messages: [...thread.messages] };
    const next = { ...thread, messages: [...thread.messages] };
    applyLocalAction(next, action, body);
    replaceThread(next);
    try {
      replaceThread(await post(`/api/threads/${thread.id}/${action}`, body ? { body } : {}));
    } catch (error) {
      replaceThread(previous);
      console.error(error);
    }
  }, [replaceThread]);

  const submitDraft = useCallback(async (body: string) => {
    if (!draft) return;
    if (!body) { setDraft(null); return; }
    const path = draft.path;
    await post("/api/threads", { ...draft, body });
    setDraft(null);
    await loadThreads();
    setSelectedFile(path);
  }, [draft, loadThreads]);

  useEffect(() => {
    void refresh();
    void loadBranches();
  }, [refresh, loadBranches]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string };
      if (message.type === "diff") {
        void refresh();
        void loadBranches();
      } else if (message.type === "threads") {
        void loadThreads();
      } else if (message.type === "connected") {
        console.info("[diffloop] connected");
        void refresh();
        void loadBranches();
      }
    };
    events.onerror = () => console.warn("[diffloop] event stream disconnected; reconnecting");
    return () => events.close();
  }, [refresh, loadThreads, loadBranches]);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (!data) return;
    setBaseChoice(data.base);
    setCustomBase(false);
  }, [data?.base]);

  const files = useMemo(() => {
    if (!data) return [];
    const parsed = parsePatchFiles(data.patch, { cacheKeyPrefix: "diffloop" }).flatMap((p) => p.files);
    if (parsed.length <= 1) return parsed;
    const byName = new Map(parsed.map((file) => [file.name, file]));
    const ordered: FileDiffMetadata[] = [];
    const visit = (nodes: TreeItemData[]) => {
      for (const item of nodes) {
        if (item.children) visit(item.children);
        else {
          const file = byName.get(item.value);
          if (file) ordered.push(file);
        }
      }
    };
    visit(treeFromPaths(parsed.map((file) => file.name)));
    return ordered.length === parsed.length ? ordered : parsed;
  }, [data?.patch]);
  const fileDiffs = useMemo(() => new Map(files.map((file) => [file.name, file])), [files]);
  const allDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.name.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return [...dirs];
  }, [files]);
  useEffect(() => {
    setExpanded((current) => [...new Set([...current, ...allDirs])]);
  }, [allDirs]);

  const annotationsByPath = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const file of files) {
      const list: Annotation[] = (data?.threads ?? [])
        .filter((thread) => thread.path === file.name && thread.status !== "dismissed")
        .map((thread) => ({ side: thread.side, lineNumber: thread.line, metadata: { threadId: thread.id } }));
      if (draft?.path === file.name) {
        list.push({ side: draft.side, lineNumber: draft.line, metadata: { draft: true } });
      }
      map.set(file.name, list);
    }
    return map;
  }, [files, data?.threads, draft]);

  useEffect(() => {
    setItems((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      return files.map((file) => {
        const id = `diff:${file.name}`;
        const previous = byId.get(id);
        const annotations = annotationsByPath.get(file.name) ?? [];
        if (previous && previous.fileDiff === file && previous.collapsed === collapsed
          && JSON.stringify(previous.annotations) === JSON.stringify(annotations)) return previous;
        return {
          id, type: "diff" as const, fileDiff: file, annotations, collapsed,
          version: previous ? (previous.version ?? 0) + 1 : 0,
        };
      });
    });
  }, [files, annotationsByPath, collapsed]);

  const options = useMemo<CodeViewReactOptions<AnnotationMeta, undefined>>(() => ({
    theme: themes,
    themeType: theme,
    stickyHeaders: true,
    enableGutterUtility: true,
    enableLineSelection: true,
    diffStyle: split ? "split" : "unified",
    layout: { paddingTop: 16, paddingBottom: 16, gap: 12 },
    unsafeCSS: "[data-code]{scrollbar-width:none}[data-code]::-webkit-scrollbar{width:0;height:0}",
  }), [theme, split]);

  const renderAnnotation = useStableCallback((...args: any[]) => {
    const annotation = args[0];
    if (annotation?.metadata?.threadId) return <ThreadCard threadId={annotation.metadata.threadId} />;
    if (annotation?.metadata?.draft) return <DraftCard key={`${draft?.path}:${draft?.line}`} />;
    return null;
  });

  const renderGutterUtility = useStableCallback((getHoveredLine: any, item: any) => {
    const path = String(item.id).replace(/^diff:/, "");
    return (
      <Button
        className="gutter-add-inline"
        aria-label="Comment on this line"
        onClick={() => {
          const hovered = getHoveredLine();
          if (!hovered) return;
          const side: Side = hovered.side ?? "additions";
          setDraft({
            path, side, line: hovered.lineNumber,
            anchor: anchorFor(fileDiffs.get(path), side, hovered.lineNumber),
          });
        }}
      >+</Button>
    );
  });

  const onSelectedLinesChange = useCallback((selection: CodeViewLineSelection | null) => {
    if (!selection || selection.range.start !== selection.range.end) return;
    const path = String(selection.id).replace(/^diff:/, "");
    const side: Side = selection.range.side ?? "additions";
    setDraft({ path, side, line: selection.range.start, anchor: anchorFor(fileDiffs.get(path), side, selection.range.start) });
  }, [fileDiffs]);

  const applyBase = async (ref: string) => {
    try {
      const result = await post("/api/base", { base: ref.trim() || "HEAD" });
      setBaseChoice(result.base);
      setCustomBase(false);
      await refresh();
    } catch (error) {
      window.alert(String(error));
      await refresh();
    }
  };

  const baseRefs = useMemo(() => {
    const refs = ["HEAD", ...branches.filter((ref) => ref !== "HEAD")];
    if (baseChoice && !refs.includes(baseChoice)) refs.push(baseChoice);
    return refs;
  }, [branches, baseChoice]);

  const sendAll = () => {
    const targets = (data?.threads ?? []).filter((t) => t.status === "open" || t.status === "stale");
    if (!targets.length) return;
    const optimistic = new Map<string, Thread>();
    for (const thread of targets) {
      const next = { ...thread, messages: [...thread.messages] };
      applyLocalAction(next, "send");
      optimistic.set(thread.id, next);
    }
    setData((current) => current ? {
      ...current,
      threads: current.threads.map((thread) => optimistic.get(thread.id) ?? thread),
    } : current);
    setSendNote(`✓ Sent ${targets.length}`);
    window.setTimeout(() => setSendNote(null), 1500);
    void Promise.all(targets.map(async (thread) => {
      try { replaceThread(await post(`/api/threads/${thread.id}/send`, {})); }
      catch (error) { console.error(error); }
    }));
  };

  const reviewValue: ReviewContextValue = {
    threads: data?.threads ?? [], draft, replyOpen, replyDrafts,
    setReplyOpen, setReplyDrafts, threadAction, submitDraft,
  };

  return (
    <ReviewContext.Provider value={reviewValue}>
      <header id="topbar">
        <div className="logo" title="diffloop">✚</div>
        <Input className="source" readOnly value={data?.repo ?? ""} aria-label="Repository" />
        <Select
          items={[...baseRefs, "__custom__"]}
          value={customBase ? "__custom__" : baseChoice}
          onValueChange={(value) => {
            const ref = String(value);
            if (ref === "__custom__") { setCustomBase(true); return; }
            setCustomBase(false);
            setBaseChoice(ref);
            void applyBase(ref);
          }}
        >
          <SelectTrigger className="base-select" aria-label="Diff base ref">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="base-menu">
            {[...baseRefs, "__custom__"].map((ref) => (
              <SelectItem key={ref} value={ref} className="base-menu-item">
                {ref === "__custom__" ? "Other ref…" : ref}
                <SelectItemIndicator>✓</SelectItemIndicator>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {customBase && (
          <>
            <Input
              className="base-input"
              autoFocus
              value={customRef}
              placeholder="tag or commit"
              aria-label="Custom diff base ref"
              onValueChange={setCustomRef}
              onKeyDown={(event) => {
                if (event.key === "Enter") void applyBase(customRef);
              }}
            />
            <Button onClick={() => void applyBase(customRef)}>Apply</Button>
          </>
        )}
        <div className="top-actions">
          <Toggle
            className="icon-toggle"
            aria-label="Split diff view"
            pressed={split}
            onPressedChange={setSplit}
          >⇄</Toggle>
          <Button onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? "Expand all files" : "Collapse all files"}
          </Button>
          <Toggle
            className="icon-toggle"
            aria-label="Dark theme"
            pressed={theme === "dark"}
            onPressedChange={(pressed) => setTheme(pressed ? "dark" : "light")}
          >◐</Toggle>
          <Button
            className="icon-toggle"
            aria-label="Show file search"
            onClick={() => document.querySelector<HTMLInputElement>(".file-search")?.focus()}
          >⌕</Button>
          <Button className={sendNote ? "accent done" : "accent"} onClick={sendAll}>
            {sendNote ?? "Send to agent"}
          </Button>
        </div>
      </header>
      <main>
        <aside id="sidebar">
          <div className="side-head"><strong>Files</strong><span className="hint">click a gutter + or a line to comment</span></div>
          <div id="file-panel" className="panel">
            <Input
              className="file-search"
              placeholder="Search files"
              aria-label="Search files"
              value={query}
              onValueChange={setQuery}
            />
            <FileTree
              files={files}
              query={query}
              selected={selectedFile}
              expanded={expanded}
              onExpandedChange={setExpanded}
              onSelect={(path) => {
                setSelectedFile(path);
                viewer.current?.scrollTo({ type: "item", id: `diff:${path}`, align: "start" });
              }}
            />
          </div>
          <div className="stats">
            <Button className="stats-toggle">▾ Diff Stats (F2)</Button>
            <div id="stats-body">
              <div className="stat-line"><span>Files</span><span>{data?.stats.files ?? 0}</span></div>
              <div className="stat-line add"><span>Additions</span><span>{(data?.stats.additions ?? 0).toLocaleString()}</span></div>
              <div className="stat-line del"><span>Deletions</span><span>{(data?.stats.deletions ?? 0).toLocaleString()}</span></div>
              <div className="stat-line"><span>Review threads</span><span>{data?.threads.length ?? 0}</span></div>
            </div>
          </div>
        </aside>
        <section id="diff" ref={diffRef}>
          <CodeView<AnnotationMeta, undefined>
            ref={viewer}
            items={items}
            options={options}
            style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }}
            renderAnnotation={renderAnnotation}
            renderGutterUtility={renderGutterUtility}
            onSelectedLinesChange={onSelectedLinesChange}
          />
          <DiffScrollbar sectionRef={diffRef} revision={items} layout={`${split}:${collapsed}`} />
        </section>
      </main>
    </ReviewContext.Provider>
  );
}

const agent = createAgent();
Object.assign(window, { agent });

createRoot(document.getElementById("app")!).render(<App />);
