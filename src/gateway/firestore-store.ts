import type { Firestore } from "firebase-admin/firestore";
import type { Store, Transaction } from "./store.js";

export class FirestoreStore implements Store {
  constructor(private readonly database: Firestore) {}

  async get<T>(path: string): Promise<T | undefined> {
    const document = await this.database.doc(path).get();
    return document.exists ? document.data() as T : undefined;
  }

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.database.runTransaction(async (transaction) => work({
      get: async <Value>(path: string): Promise<Value | undefined> => {
        const document = await transaction.get(this.database.doc(path));
        return document.exists ? document.data() as Value : undefined;
      },
      set: (path, value) => { transaction.set(this.database.doc(path), value); },
    }));
  }

  async dueMessageIds(collection: string, nowMs: number, limit: number): Promise<string[]> {
    const documents = await this.database.collection(collection)
      .where("status", "==", "pending")
      .where("next_dispatch_at_ms", "<=", nowMs)
      .orderBy("next_dispatch_at_ms")
      .limit(limit)
      .get();
    return documents.docs.map((document) => document.id);
  }
}
