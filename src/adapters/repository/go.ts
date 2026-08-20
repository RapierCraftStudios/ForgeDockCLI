// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter, LANGUAGE_PROFILES } from "./bounded-adapter.js";
export const goRepositoryAdapter = new BoundedRepositoryAdapter("go", ["go"], LANGUAGE_PROFILES.go.extensions, LANGUAGE_PROFILES.go.manifests);
export { BoundedRepositoryAdapter };