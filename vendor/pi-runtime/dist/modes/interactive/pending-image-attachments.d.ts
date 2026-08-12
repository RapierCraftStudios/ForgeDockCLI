import type { ImageContent } from "@earendil-works/pi-ai";
export interface PendingImageAttachment {
    id: string;
    index: number;
    marker: string;
    image: ImageContent;
}
export interface SubmittedInput {
    text: string;
    images?: ImageContent[];
}
/**
 * Keeps clipboard images in memory while the editor contains lightweight,
 * user-removable markers. A submission consumes the queue exactly once.
 */
export declare class PendingImageAttachments {
    private attachments;
    private nextIndex;
    add(image: ImageContent): PendingImageAttachment;
    consume(text: string): SubmittedInput;
    clear(): void;
    get size(): number;
}
//# sourceMappingURL=pending-image-attachments.d.ts.map