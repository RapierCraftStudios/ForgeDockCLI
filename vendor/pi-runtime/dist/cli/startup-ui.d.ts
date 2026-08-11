import { TUI } from "@earendil-works/pi-tui";
import { SettingsManager } from "../core/settings-manager.ts";
export declare function createStartupTui(settingsManager: SettingsManager): Promise<TUI>;
export declare function startStartupTui(ui: TUI, settingsManager: SettingsManager): void;
export declare function shouldRunFirstTimeSetup(settingsPath?: string, onboardingPath?: string, authPath?: string): boolean;
export declare function showStartupSelector<T>(settingsManager: SettingsManager, title: string, options: Array<{
    label: string;
    value: T;
}>): Promise<T | undefined>;
/** Show the first-time setup dialog and persist the result */
export declare function showFirstTimeSetup(settingsManager: SettingsManager): Promise<boolean>;
export declare function showStartupInput(settingsManager: SettingsManager, title: string, placeholder?: string): Promise<string | undefined>;
//# sourceMappingURL=startup-ui.d.ts.map