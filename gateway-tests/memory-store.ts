import type { Store, Transaction } from "../src/gateway/store.js";
import type { Message } from "../src/gateway/types.js";

// Serialized, isolated transactions provide a deterministic test double. The
// separate emulator suite exercises the real Firestore adapter and contention.
export class MemoryStore implements Store {
  readonly documents = new Map<string, object>();
  private tail: Promise<unknown> = Promise.resolve();

  async get<T>(path: string): Promise<T | undefined> {
    return structuredClone(this.documents.get(path)) as T | undefined;
  }

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const writes = new Map<string, object>();
      const value = await work({
        get: async <Value>(path: string): Promise<Value | undefined> => {
          if (writes.size > 0) throw new Error("Firestore requires reads before writes.");
          return this.get<Value>(path);
        },
        set: (path, document) => { writes.set(path, structuredClone(document)); },
      });
      for (const [path, document] of writes) this.documents.set(path, document);
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async dueMessageIds(collection: string, nowMs: number, limit: number): Promise<string[]> {
    return [...this.documents.entries()]
      .filter(([path, value]) => path.startsWith(`${collection}/`) && (value as Message).status === "pending" && (value as Message).next_dispatch_at_ms <= nowMs)
      .sort((a, b) => (a[1] as Message).next_dispatch_at_ms - (b[1] as Message).next_dispatch_at_ms)
      .slice(0, limit)
      .map(([, value]) => (value as Message).id);
  }
}
