import { TUI } from "@earendil-works/pi-tui";
import { SettingsManager } from "../core/settings-manager.ts";
export declare function createStartupTui(settingsManager: SettingsManager): Promise<TUI>;
export declare function startStartupTui(ui: TUI, settingsManager: SettingsManager): void;
/**
 * First-time setup is mandatory-by-default for the ForgeDock distribution and
 * remains experimental for upstream Pi. ForgeDock uses a completion receipt
 * rather than settings.json because theme settings are persisted before
 * provider authentication and model selection finish.
 */
export declare function shouldRunFirstTimeSetup(settingsPath?: string, onboardingPath?: string): boolean;
export declare function showStartupSelector<T>(settingsManager: SettingsManager, title: string, options: Array<{
    label: string;
    value: T;
}>): Promise<T | undefined>;
/** Show the first-time setup dialog and persist the result */
export declare function showFirstTimeSetup(settingsManager: SettingsManager): Promise<boolean>;
export declare function showStartupInput(settingsManager: SettingsManager, title: string, placeholder?: string): Promise<string | undefined>;
//# sourceMappingURL=startup-ui.d.ts.map