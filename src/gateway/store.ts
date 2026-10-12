export interface Transaction {
  get<T>(path: string): Promise<T | undefined>;
  set(path: string, value: object): void;
}

export interface Store {
  get<T>(path: string): Promise<T | undefined>;
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
  dueMessageIds(collection: string, nowMs: number, limit: number): Promise<string[]>;
}
