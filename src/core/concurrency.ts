// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keep remote read fan-out bounded without changing the order in which
 * callers observe results. The mapper is invoked in input order as workers
 * become available, and the returned array always follows input order even
 * when individual reads complete out of order.
 */
export const DEFAULT_REMOTE_READ_CONCURRENCY = 8;

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R> | R,
  concurrency = DEFAULT_REMOTE_READ_CONCURRENCY,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrent map limit must be a positive integer");
  }
  if (!values.length) return [];

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
