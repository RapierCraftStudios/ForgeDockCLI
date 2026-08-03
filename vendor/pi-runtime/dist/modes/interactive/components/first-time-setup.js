import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
const THEME_OPTIONS = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
];
const ANALYTICS_OPTIONS = [
    { value: true, label: "Share anonymous usage data" },
    { value: false, label: "Don't share" },
];
const SETUP_LOGO_LINES = APP_NAME === "forgedock" ? ["   ▄▄████████", " ▄█████▀▀▀▀▀", " ▀▀ ▄████▀", "   ▀▀▀"] : ["██████", "██  ██", "████  ██", "██    ██"];
/** First-time setup dialog: theme choice and analytics opt-in. */
export class FirstTimeSetupComponent extends Container {
    step = APP_NAME === "forgedock" ? "welcome" : "theme";
    themeIndex;
    analyticsIndex = APP_NAME === "forgedock" ? 1 : 0;
    options;
    constructor(options) {
        super();
        this.options = options;
        this.themeIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.value === options.detectedTheme));
        this.update();
    }
    // Rebuild the whole dialog on every change so theme previews recolor all text.
    update() {
        this.clear();
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
        this.addChild(new Spacer(1));
        const welcome = APP_NAME === "forgedock"
            ? "Welcome to ForgeDock — provider-neutral software delivery."
            : `Welcome to ${APP_NAME}, the minimal coding agent.`;
        this.addChild(new Text(theme.fg("accent", theme.bold(welcome)), 1, 0));
        this.addChild(new Spacer(1));
        if (this.step === "welcome") {
            this.addChild(new Text(theme.fg("text", theme.bold("Delivery with durable memory and deterministic gates.")), 1, 0));
            this.addChild(new Text(theme.fg("muted", "GitHub stores intent, evidence, review, and outcomes.\nModels can change; your workflow record does not."), 1, 0));
            this.addChild(new Spacer(1));
            this.addChild(new Text(theme.fg("text", "First-run setup"), 1, 0));
            this.addChild(new Text(theme.fg("muted", "  1  Choose your terminal appearance\n  2  Connect a model provider\n  3  Select the model ForgeDock should use"), 1, 0));
        }
        else if (this.step === "theme") {
            this.addChild(new Text(theme.fg("text", "Choose your terminal appearance."), 1, 0));
            this.addChild(new Text(theme.fg("muted", `Detected system appearance: ${this.options.detectedTheme}`), 1, 0));
            this.addChild(new Spacer(1));
            this.addOptionList(THEME_OPTIONS.map((option) => option.label), this.themeIndex);
        }
        else {
            this.addChild(new Text(theme.fg("text", "Opt-in to anonymous usage data sharing?"), 1, 0));
            this.addChild(new Text(theme.fg("muted", APP_NAME === "forgedock"
                ? "Analytics are off by default in ForgeDock. You can change this preference\nanytime in settings.json."
                : "Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Pi. You can observe what is shared using /privacy and make\nchanges anytime in settings.json."), 1, 0));
            this.addChild(new Spacer(1));
            this.addOptionList(ANALYTICS_OPTIONS.map((option) => option.label), this.analyticsIndex);
        }
        this.addChild(new Spacer(1));
        this.addChild(new Text(rawKeyHint("↑↓", "navigate") +
            "  " +
            keyHint("tui.select.confirm", this.step === "analytics" ? "continue to provider login" : "continue") +
            "  " +
            keyHint("tui.select.cancel", APP_NAME === "forgedock" ? "exit setup" : "skip setup"), 1, 0));
        this.addChild(new Spacer(1));
        this.addChild(new DynamicBorder());
    }
    addOptionList(labels, selectedIndex) {
        for (let i = 0; i < labels.length; i++) {
            const isSelected = i === selectedIndex;
            const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
            const label = isSelected ? theme.fg("accent", labels[i]) : theme.fg("text", labels[i]);
            this.addChild(new Text(`${prefix}${label}`, 1, 0));
        }
    }
    moveSelection(delta) {
        if (this.step === "welcome") {
            return;
        }
        if (this.step === "theme") {
            const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
            if (next !== this.themeIndex) {
                this.themeIndex = next;
                this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
            }
        }
        else {
            this.analyticsIndex = Math.max(0, Math.min(ANALYTICS_OPTIONS.length - 1, this.analyticsIndex + delta));
        }
        this.update();
    }
    handleInput(keyData) {
        const kb = getKeybindings();
        if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
            this.moveSelection(-1);
        }
        else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
            this.moveSelection(1);
        }
        else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
            if (this.step === "welcome") {
                this.step = "theme";
                this.update();
            }
            else if (this.step === "theme") {
                this.step = "analytics";
                this.update();
            }
            else {
                this.options.onSubmit({
                    theme: THEME_OPTIONS[this.themeIndex].value,
                    shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
                });
            }
        }
        else if (kb.matches(keyData, "tui.select.cancel")) {
            this.options.onCancel();
        }
    }
}
//# sourceMappingURL=first-time-setup.js.map