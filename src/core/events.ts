import type { AgentEvent } from "./types.js";

type EventType = AgentEvent["type"];
type Handler<T extends EventType> = (event: Extract<AgentEvent, { type: T }>) => void;

export class Emitter {
  private handlers = new Map<EventType, Set<(event: AgentEvent) => void>>();

  on<T extends EventType>(type: T, fn: Handler<T>): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as (event: AgentEvent) => void);
  }

  off<T extends EventType>(type: T, fn: Handler<T>): void {
    this.handlers.get(type)?.delete(fn as (event: AgentEvent) => void);
  }

  emit(event: AgentEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const fn of [...set]) fn(event);
  }
}
