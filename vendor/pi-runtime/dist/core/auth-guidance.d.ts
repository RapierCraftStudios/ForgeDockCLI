export declare function getProviderLoginHelp(): string;
export declare function formatNoModelsAvailableMessage(): string;
/**
 * Interactive ForgeDock onboarding authenticates the provider after session
 * creation, so a pre-auth no-model fallback would be stale and misleading.
 */
export declare function modelFallbackMessageForInteractiveStartup(message: string | undefined, forgeDockOnboarding: boolean): string | undefined;
export declare function formatNoModelSelectedMessage(): string;
export declare function formatNoApiKeyFoundMessage(provider: string): string;
//# sourceMappingURL=auth-guidance.d.ts.map