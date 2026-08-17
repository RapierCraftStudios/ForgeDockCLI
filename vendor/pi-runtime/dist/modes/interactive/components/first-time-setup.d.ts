import { Container } from "@earendil-works/pi-tui";
import { type TerminalTheme } from "../theme/theme.ts";
export interface FirstTimeSetupResult {
    theme: TerminalTheme;
    shareAnalytics: boolean;
}
export interface FirstTimeSetupOptions {
    detectedTheme: TerminalTheme;
    onThemePreview: (themeName: TerminalTheme) => void;
    onSubmit: (result: FirstTimeSetupResult) => void;
    onCancel: () => void;
    onRender?: () => void;
}
/** First-time setup dialog: appearance and (for upstream Pi) analytics opt-in. */
export declare class FirstTimeSetupComponent extends Container {
    private step;
    private themeIndex;
    private analyticsIndex;
    private readonly options;
    private brandText?;
    private brandShinePosition;
    private shineTimer?;
    constructor(options: FirstTimeSetupOptions);
    private update;
    private addOptionList;
    private moveSelection;
    handleInput(keyData: string): void;
    private startBrandShine;
    dispose(): void;
}
//# sourceMappingURL=first-time-setup.d.ts.map