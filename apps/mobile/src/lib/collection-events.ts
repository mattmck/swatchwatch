/**
 * "The collection changed" signal for screens that stay mounted in the tab navigator (the
 * Collection tab and its Home panel only fetch on mount or pull-to-refresh). A screen that adds
 * a polish outside them, like the manual add form, calls `notifyCollectionChanged()`; the
 * Collection refetches its first page, which also rewrites its offline cache.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe function (use as an effect cleanup). */
export function onCollectionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyCollectionChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One failing screen must not stop the others from refreshing.
    }
  }
}
