// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ForgeDock Chrome & Ember identity.
 * Geometry and palette are carried forward from the approved Cinematic
 * Installer assets in bin/cinema.mjs; this module is independent of the
 * legacy TUI and contains presentation only.
 */

export const CHROME_STOPS = ["#f7f3ea", "#d9cfba", "#a99a82", "#6e6252"] as const;
export const EMBER_STOPS = ["#ff4d00", "#ff8c1a", "#ffd166"] as const;

export const HERO_MARK = [
  "            ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  "        ▄▄██████████████████",
  "     ▄█████████████▀▀▀▀▀▀▀▀▀",
  "   ▄██████████▀▀",
  "    ▀▀▀▀▀  ▄▄███████▀",
  "        ▄████████▀",
  "      ▄██████▀",
  "       ▀▀▀▀",
] as const;

export const COMPACT_MARK = [
  "   ▄▄████████",
  " ▄█████▀▀▀▀▀",
  " ▀▀ ▄████▀",
  "   ▀▀▀",
] as const;

export type ColorMode = "truecolor" | "256" | "none";

export function colorMode(env = process.env, output: { isTTY?: boolean } = process.stdout): ColorMode {
  if (output.isTTY !== true || env.NO_COLOR || env.TERM === "dumb") return "none";
  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit") || process.platform === "win32") return "truecolor";
  return "256";
}

export function renderMark(size: "hero" | "compact", mode: ColorMode): string[] {
  const mark = size === "hero" ? HERO_MARK : COMPACT_MARK;
  return mark.map((line, row) => gradientLine(line, CHROME_STOPS, mode, row * 0.06));
}

export function ember(text: string, mode: ColorMode): string {
  return gradientLine(text, EMBER_STOPS, mode);
}

export function renderHeader(options: {
  mode?: ColorMode;
  output?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  subtitle?: string;
  compact?: boolean;
} = {}): string {
  const mode = options.mode ?? colorMode(options.env, options.output);
  const mark = renderMark(options.compact === false ? "hero" : "compact", mode);
  const wordmark = ember("F O R G E D O C K", mode);
  const subtitle = options.subtitle ?? "provider-neutral delivery · GitHub memory";
  return `${mark.join("\n")}\n${wordmark}\n${dim(subtitle, mode)}`;
}

export function statusGlyph(status: "active" | "passed" | "failed" | "blocked", mode: ColorMode): string {
  const values = {
    active: { glyph: "◆", rgb: [255, 140, 26] as const },
    passed: { glyph: "✓", rgb: [126, 226, 168] as const },
    failed: { glyph: "✕", rgb: [255, 110, 86] as const },
    blocked: { glyph: "■", rgb: [243, 202, 114] as const },
  };
  const value = values[status];
  return mode === "none" ? value.glyph : `${foreground(value.rgb, mode)}${value.glyph}\x1b[0m`;
}

function gradientLine(text: string, stops: readonly string[], mode: ColorMode, phase = 0): string {
  if (mode === "none") return text;
  const chars = [...text];
  const denominator = Math.max(chars.length - 1, 1);
  let result = "";
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (char === " ") {
      result += char;
      continue;
    }
    const rgb = sampleGradient(stops, Math.min(index / denominator + phase, 1));
    result += `${foreground(rgb, mode)}${char}`;
  }
  return `${result}\x1b[0m`;
}

function sampleGradient(stops: readonly string[], value: number): readonly [number, number, number] {
  if (stops.length < 2) throw new Error("A gradient needs at least two stops");
  const colors = stops.map(hexToRgb);
  const clamped = Math.min(Math.max(value, 0), 1);
  const scaled = clamped * (colors.length - 1);
  const segment = Math.min(Math.floor(scaled), colors.length - 2);
  const local = scaled - segment;
  const left = colors[segment];
  const right = colors[segment + 1];
  if (!left || !right) throw new Error("Invalid gradient segment");
  const mix = (a: number, b: number) => Math.round(a + (b - a) * local);
  return [mix(left[0], right[0]), mix(left[1], right[1]), mix(left[2], right[2])];
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const value = hex.replace("#", "");
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function foreground(rgb: readonly [number, number, number], mode: ColorMode): string {
  if (mode === "none") return "";
  if (mode === "256") {
    const quantize = (value: number) => Math.round(value / 255 * 5);
    return `\x1b[38;5;${16 + 36 * quantize(rgb[0]) + 6 * quantize(rgb[1]) + quantize(rgb[2])}m`;
  }
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function dim(text: string, mode: ColorMode): string {
  return mode === "none" ? text : `\x1b[2m${text}\x1b[22m`;
}
