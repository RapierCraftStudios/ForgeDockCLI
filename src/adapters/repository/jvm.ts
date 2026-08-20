// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter } from "./bounded-adapter.js";
export const jvmRepositoryAdapter = new BoundedRepositoryAdapter("jvm", ["jvm"]);
export { BoundedRepositoryAdapter };
