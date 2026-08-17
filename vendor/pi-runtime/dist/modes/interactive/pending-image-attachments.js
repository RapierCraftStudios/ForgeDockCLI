import { randomUUID } from "node:crypto";
/**
 * Keeps clipboard images in memory while the editor contains lightweight,
 * user-removable markers. A submission consumes the queue exactly once.
 */
export class PendingImageAttachments {
    attachments = [];
    nextIndex = 1;
    add(image) {
        const index = this.nextIndex++;
        const attachment = {
            id: randomUUID(),
            index,
            marker: `[Image #${index}]`,
            image,
        };
        this.attachments.push(attachment);
        return attachment;
    }
    consume(text) {
        const images = this.attachments
            .filter((attachment) => text.includes(attachment.marker))
            .map((attachment) => attachment.image);
        this.clear();
        return images.length ? { text, images } : { text };
    }
    clear() {
        this.attachments = [];
        this.nextIndex = 1;
    }
    get size() {
        return this.attachments.length;
    }
}
//# sourceMappingURL=pending-image-attachments.js.map