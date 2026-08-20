// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter } from "./bounded-adapter.js";
export const monorepoRepositoryAdapter = new BoundedRepositoryAdapter("monorepo", ["monorepo"]);
export const generatedManifestAdapter = new BoundedRepositoryAdapter("generated-manifest", ["generated"]);
export { BoundedRepositoryAdapter };
