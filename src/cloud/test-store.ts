import type { CloudEntry, CloudStore } from "./store";

/** A cloud store in memory, for tests. Counts the files written. */
export class MemoryStore implements CloudStore {
  readonly files = new Map<string, Blob>();
  writes: string[] = [];
  reads: string[] = [];

  list(folder: string): Promise<CloudEntry[]> {
    const prefix = `${folder}/`;
    const entries = new Map<string, CloudEntry>();
    for (const [path, blob] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      entries.set(name, { name, folder: rest.length > 0, size: rest.length ? 0 : blob.size });
    }
    return Promise.resolve([...entries.values()]);
  }

  read(path: string): Promise<Blob | null> {
    this.reads.push(path);
    return Promise.resolve(this.files.get(path) ?? null);
  }

  write(path: string, data: Blob, progress?: (sent: number) => void): Promise<void> {
    this.writes.push(path);
    this.files.set(path, data);
    progress?.(data.size);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
    return Promise.resolve();
  }
}
