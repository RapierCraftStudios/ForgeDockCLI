// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter } from "./bounded-adapter.js";
export const rustRepositoryAdapter = new BoundedRepositoryAdapter("rust", ["rust"]);
export { BoundedRepositoryAdapter };
