// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CheckResult } from "../../core/ports/verification.js";
import type {
  VerificationReceiptCache,
  VerificationReceiptCacheEntry,
  VerificationReceiptCacheKey,
} from "../../core/ports/verification-receipt-cache.js";
import { SqliteRepositories } from "./sqlite-repositories.js";

/** Named adapter for the receipt-cache portion of the operational state DB. */
export class SqliteVerificationReceiptCache implements VerificationReceiptCache {
  constructor(readonly repositories: Pick<SqliteRepositories, "get" | "put">) {}
  get(key: VerificationReceiptCacheKey): Promise<VerificationReceiptCacheEntry | undefined> { return this.repositories.get(key); }
  put(key: VerificationReceiptCacheKey, check: CheckResult): Promise<boolean> { return this.repositories.put(key, check); }
}
