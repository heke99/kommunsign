/**
 * Remembers, for one storage adapter, that a bucket has been confirmed to exist.
 *
 * Issuing an upload grant used to check the bucket first, every time: a cross-region call to ask
 * whether a bucket that has existed since provisioning still exists, on the critical path of every
 * upload. The answer cannot change in a way that matters here -- a bucket is created once and never
 * removed while the service runs -- and if it somehow did, the signed URL that follows would fail
 * immediately and visibly rather than silently doing the wrong thing.
 *
 * The memo belongs to the adapter rather than the module. A process-wide cache would mean one
 * adapter's confirmation answering for another's, which is wrong the moment two adapters point at
 * different storage, and it would make behaviour depend on what ran earlier in the process.
 *
 * Concurrent callers share one in-flight check rather than each making their own. A failed check is
 * never remembered, so a transient error does not turn into a permanently unusable bucket.
 */
export function createBucketMemo(): (bucket: string, confirm: () => Promise<void>) => Promise<void> {
  const confirmed = new Map<string, Promise<void>>();
  return (bucket, confirm) => {
    const existing = confirmed.get(bucket);
    if (existing) return existing;
    const pending = confirm().catch((cause: unknown) => {
      confirmed.delete(bucket);
      throw cause;
    });
    confirmed.set(bucket, pending);
    return pending;
  };
}
