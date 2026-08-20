// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoundedRepositoryAdapter, LANGUAGE_PROFILES } from "./bounded-adapter.js";
export const pythonRepositoryAdapter = new BoundedRepositoryAdapter("python", ["python"], LANGUAGE_PROFILES.python.extensions, LANGUAGE_PROFILES.python.manifests);
export { BoundedRepositoryAdapter };