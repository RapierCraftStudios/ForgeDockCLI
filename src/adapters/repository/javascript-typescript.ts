// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter, LANGUAGE_PROFILES } from "./bounded-adapter.js";
export const javascriptRepositoryAdapter = new BoundedRepositoryAdapter("javascript", ["javascript"], LANGUAGE_PROFILES.javascript.extensions, LANGUAGE_PROFILES.javascript.manifests);
export const typescriptRepositoryAdapter = new BoundedRepositoryAdapter("typescript", ["typescript", "javascript"], LANGUAGE_PROFILES.typescript.extensions, LANGUAGE_PROFILES.typescript.manifests);
export { BoundedRepositoryAdapter as JavaScriptRepositoryAdapter };