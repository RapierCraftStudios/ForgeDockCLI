// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter, LANGUAGE_PROFILES } from "./bounded-adapter.js";
export const rustRepositoryAdapter = new BoundedRepositoryAdapter("rust", ["rust"], LANGUAGE_PROFILES.rust.extensions, LANGUAGE_PROFILES.rust.manifests);
export { BoundedRepositoryAdapter };