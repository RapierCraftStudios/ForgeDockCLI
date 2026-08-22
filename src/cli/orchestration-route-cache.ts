// SPDX-License-Identifier: AGPL-3.0-or-later

import { orchestrationIssueIdentityKey, type OrchestrationIssueIdentity } from "../core/ports/orchestration.js";

/** Mutable CLI routing state keyed by the durable repository-qualified identity. */
export type OrchestrationRouteCache<T> = Map<string, T>;

/** Return the canonical key shared with durable orchestration ownership checks. */
export function orchestrationRouteCacheKey(repository: string, issue: number): string {
  return orchestrationIssueIdentityKey({ repository, issue });
}

/** Store a route without allowing equal issue numbers in other repositories to alias it. */
export function setOrchestrationRoute<T>(
  routes: OrchestrationRouteCache<T>,
  identity: OrchestrationIssueIdentity,
  route: T,
): void {
  routes.set(orchestrationIssueIdentityKey(identity), route);
}

/** Look up a route by its normalized repository-qualified identity. */
export function getOrchestrationRoute<T>(
  routes: ReadonlyMap<string, T>,
  identity: OrchestrationIssueIdentity,
): T | undefined {
  return routes.get(orchestrationIssueIdentityKey(identity));
}

/** Fail closed with the qualified identity when authoritative route evidence is absent. */
export function requiredOrchestrationRoute<T>(
  routes: ReadonlyMap<string, T>,
  identity: OrchestrationIssueIdentity,
): T {
  const route = getOrchestrationRoute(routes, identity);
  if (!route) {
    throw new Error(`Issue ${identity.repository.trim().toLowerCase()}#${identity.issue} has no authoritative lane classification`);
  }
  return route;
}
