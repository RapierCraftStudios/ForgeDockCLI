import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME, VERSION } from "../../../config.js";
import { theme } from "../theme/theme.js";
import { forgeDockBrandShinePosition, renderForgeDockBrand, shouldAnimateForgeDockBrand, } from "./forgedock-header.js";
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
const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];
/** First-time setup dialog: appearance and (for upstream Pi) analytics opt-in. */
export class FirstTimeSetupComponent extends Container {
    step = APP_NAME === "forgedock" ? "welcome" : "theme";
    themeIndex;
    analyticsIndex = 0;
    options;
    brandText;
    brandShinePosition;
    shineTimer;
    constructor(options) {
        super();
        this.options = options;
        this.themeIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.value === options.detectedTheme));
        this.update();
        this.startBrandShine();
    }
    // Rebuild the whole dialog on every change so theme previews recolor all text.
    update() {
        this.clear();
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.brandText = new Text(APP_NAME === "forgedock"
            ? renderForgeDockBrand(VERSION, this.brandShinePosition)
            : theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0);
        this.addChild(this.brandText);
        this.addChild(new Spacer(1));
        const welcome = APP_NAME === "forgedock"
            ? "Welcome to ForgeDock — provider-neutral software delivery with GitHub as durable institutional memory."
            : `Welcome to ${APP_NAME}, the minimal coding agent.`;
        this.addChild(new Text(theme.fg("accent", theme.bold(welcome)), 1, 0));
        this.addChild(new Spacer(1));
        if (this.step === "welcome") {
            this.addChild(new Text(theme.fg("text", theme.bold("Delivery with durable memory and deterministic gates.")), 1, 0));
            this.addChild(new Text(theme.fg("muted", "GitHub stores intent, evidence, review, and outcomes.\nModels can change; your workflow record does not."), 1, 0));
            this.addChild(new Spacer(1));
            this.addChild(new Text(theme.fg("text", "First-run setup"), 1, 0));
            this.addChild(new Text(theme.fg("muted", "  1  Choose your terminal appearance\n  2  Connect a provider account or API key\n  3  Select the model ForgeDock should use"), 1, 0));
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
        const navigationHint = this.step === "welcome"
            ? keyHint("tui.select.confirm", "begin setup")
            : rawKeyHint("↑↓", "navigate") +
                "  " +
                keyHint("tui.select.confirm", this.step === "analytics"
                    ? "continue to provider login"
                    : APP_NAME === "forgedock"
                        ? "continue to provider setup"
                        : "continue");
        this.addChild(new Text(navigationHint + "  " + keyHint("tui.select.cancel", APP_NAME === "forgedock" ? "exit setup" : "skip setup"), 1, 0));
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
                if (APP_NAME === "forgedock") {
                    this.options.onSubmit({
                        theme: THEME_OPTIONS[this.themeIndex].value,
                        shareAnalytics: false,
                    });
                }
                else {
                    this.step = "analytics";
                    this.update();
                }
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
    startBrandShine() {
        if (APP_NAME !== "forgedock" || !shouldAnimateForgeDockBrand())
            return;
        const frames = 14;
        let frame = 0;
        this.brandShinePosition = forgeDockBrandShinePosition(frame, frames);
        this.brandText?.setText(renderForgeDockBrand(VERSION, this.brandShinePosition));
        this.options.onRender?.();
        this.shineTimer = setInterval(() => {
            frame += 1;
            this.brandShinePosition =
                frame <= frames ? forgeDockBrandShinePosition(frame, frames) : undefined;
            this.brandText?.setText(renderForgeDockBrand(VERSION, this.brandShinePosition));
            this.options.onRender?.();
            if (frame > frames && this.shineTimer) {
                clearInterval(this.shineTimer);
                this.shineTimer = undefined;
            }
        }, 55);
        this.shineTimer.unref?.();
    }
    dispose() {
        if (this.shineTimer)
            clearInterval(this.shineTimer);
        this.shineTimer = undefined;
    }
}
//# sourceMappingURL=first-time-setup.js.map