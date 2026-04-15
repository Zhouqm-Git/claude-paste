/**
 * Content block types for mixed text + image content.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; path: string; fileName: string };

/**
 * Serialize content blocks into a single text string for terminal input.
 * - Text blocks: included as-is
 * - Image blocks: serialized as the pure file path
 *   (Claude Code auto-detects image files via extension regex: /\.(png|jpe?g|gif|webp)$/i)
 */
export function serializeBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      const trimmed = block.text;
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    } else if (block.type === "image") {
      parts.push(block.path);
    }
  }

  return parts.join("\n");
}
