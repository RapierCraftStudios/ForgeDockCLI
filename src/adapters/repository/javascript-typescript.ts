// SPDX-License-Identifier: AGPL-3.0-or-later
export { BoundedRepositoryAdapter as JavaScriptRepositoryAdapter } from "./bounded-adapter.js";
import { BoundedRepositoryAdapter } from "./bounded-adapter.js";
export const javascriptRepositoryAdapter = new BoundedRepositoryAdapter("javascript", ["javascript"]);
export const typescriptRepositoryAdapter = new BoundedRepositoryAdapter("typescript", ["typescript", "javascript"]);
