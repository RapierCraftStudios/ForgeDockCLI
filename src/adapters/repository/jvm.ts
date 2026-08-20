// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter, LANGUAGE_PROFILES } from "./bounded-adapter.js";
export const jvmRepositoryAdapter = new BoundedRepositoryAdapter("jvm", ["jvm"], LANGUAGE_PROFILES.jvm.extensions, LANGUAGE_PROFILES.jvm.manifests);
export { BoundedRepositoryAdapter };