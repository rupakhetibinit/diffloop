export type Side = "additions" | "deletions";

export type ThreadStatus = "open" | "sent" | "resolved" | "dismissed" | "stale";

export interface Message {
  id: string;
  author: "you" | "agent";
  body: string;
  at: string;
}

export interface Thread {
  id: string;
  path: string;
  side: Side;
  line: number;
  anchor: string;
  messages: Message[];
  status: ThreadStatus;
  round: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepoState {
  repo: string;
  threads: Thread[];
}

export interface ServerInfo {
  port: number;
  token: string;
  repo: string;
}
