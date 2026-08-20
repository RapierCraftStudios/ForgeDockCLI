// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter } from "./bounded-adapter.js";
export const goRepositoryAdapter = new BoundedRepositoryAdapter("go", ["go"]);
export { BoundedRepositoryAdapter };
