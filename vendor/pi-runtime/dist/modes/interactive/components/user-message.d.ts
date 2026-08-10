import type { ImageContent } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
/**
 * Component that renders a user message
 */
export declare class UserMessageComponent extends Container {
    private text;
    private markdownTheme;
    private outputPad;
    private images;
    private showImages;
    private imageWidthCells;
    constructor(text: string, markdownTheme?: MarkdownTheme, outputPad?: number, images?: readonly ImageContent[], showImages?: boolean, imageWidthCells?: number);
    setOutputPad(padding: number): void;
    private rebuild;
    render(width: number): string[];
}
//# sourceMappingURL=user-message.d.ts.map