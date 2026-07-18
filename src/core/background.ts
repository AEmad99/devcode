import { shellEnv, detectRuntimeEnv } from "./runtime-env.js";
import { shellArgv } from "./tools/bash.js";

const MAX_BUF = 512 * 1024; // 512 KB; drop-middle when exceeded

export interface BgTask {
  id: string;
  command: string;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  buf: string;
  proc: { kill: () => void };
}

const tasks = new Map<string, BgTask>();
let nextId = 1;
const doneListeners = new Set<(t: BgTask) => void>();

function dropMiddle(s: string, max = MAX_BUF): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n…[${s.length - max} bytes dropped]…\n\n${s.slice(-tail)}`;
}

function appendBuf(t: BgTask, chunk: string): void {
  t.buf = dropMiddle(t.buf + chunk);
}

export function startBackground(command: string): BgTask {
  const id = `bg-${nextId++}`;
  const runtime = detectRuntimeEnv();
  const argv = shellArgv(command, runtime);
  const env = shellEnv(runtime.pathExtras);
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: process.cwd(),
  });

  const task: BgTask = {
    id,
    command,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    buf: "",
    proc: { kill: () => proc.kill() },
  };
  tasks.set(id, task);

  const drain = async (stream: ReadableStream<Uint8Array> | null, label: string) => {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) appendBuf(task, dec.decode(value, { stream: true }));
      }
    } catch {
      appendBuf(task, `\n[${label} stream error]\n`);
    }
  };

  void (async () => {
    await Promise.all([drain(proc.stdout, "stdout"), drain(proc.stderr, "stderr")]);
    const code = await proc.exited;
    task.exitCode = code;
    task.done = true;
    for (const cb of [...doneListeners]) {
      try {
        cb(task);
      } catch {
        /* swallow */
      }
    }
  })();

  return task;
}

export function readBackground(id: string, offset = 0): { ok: true; text: string; done: boolean; exitCode: number | null } | { ok: false; error: string } {
  const t = tasks.get(id);
  if (!t) return { ok: false, error: `Unknown background task: ${id}` };
  const off = Math.max(0, Math.min(offset, t.buf.length));
  return { ok: true, text: t.buf.slice(off), done: t.done, exitCode: t.exitCode };
}

export function killBackground(id: string): { ok: true; message: string } | { ok: false; error: string } {
  const t = tasks.get(id);
  if (!t) return { ok: false, error: `Unknown background task: ${id}` };
  if (t.done) return { ok: true, message: `${id} already finished (exit ${t.exitCode})` };
  try {
    t.proc.kill();
  } catch {
    /* ignore */
  }
  return { ok: true, message: `Killed ${id}` };
}

export function listBackground(): Array<{ id: string; command: string; done: boolean; exitCode: number | null; startedAt: number; bufLen: number }> {
  return [...tasks.values()].map((t) => ({
    id: t.id,
    command: t.command,
    done: t.done,
    exitCode: t.exitCode,
    startedAt: t.startedAt,
    bufLen: t.buf.length,
  }));
}

export function onBackgroundDone(cb: (t: BgTask) => void): () => void {
  doneListeners.add(cb);
  return () => doneListeners.delete(cb);
}

/** Test helper — clear registry between tests. */
export function _resetBackgroundForTests(): void {
  for (const t of tasks.values()) {
    try {
      if (!t.done) t.proc.kill();
    } catch {
      /* */
    }
  }
  tasks.clear();
  nextId = 1;
  doneListeners.clear();
}
