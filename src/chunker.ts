import * as vscode from "vscode";

// macOS PTY input buffer is ~1024 bytes; keep each UTF-8 chunk well under this limit
const MAX_CHUNK = 800;
const CHUNK_DELAY = 20;

export class OperationCancelled extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "OperationCancelled";
  }
}

export type CancellationCheck = () => boolean;

function throwIfCancelled(isCancelled: CancellationCheck) {
  if (isCancelled()) {
    throw new OperationCancelled();
  }
}

export function chunkText(text: string, maxBytes: number = MAX_CHUNK): string[] {
  const out: string[] = [];
  let buf = "";
  let bytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (buf && bytes + charBytes > maxBytes) {
      out.push(buf);
      buf = "";
      bytes = 0;
    }

    buf += char;
    bytes += charBytes;

    if (bytes === maxBytes) {
      out.push(buf);
      buf = "";
      bytes = 0;
    }
  }

  if (buf) out.push(buf);
  return out;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send text using a single bracketed paste envelope with chunked transport.
 * The application receives one paste event instead of N, reducing render cost.
 */
export async function sendChunked(
  term: vscode.Terminal,
  text: string,
  isCancelled: CancellationCheck
) {
  const chunks = chunkText(text, MAX_CHUNK);

  term.sendText("\x1b[200~", false);
  let pasteClosed = false;

  try {
    for (let i = 0; i < chunks.length; i++) {
      throwIfCancelled(isCancelled);
      term.sendText(chunks[i], false);

      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY);
        throwIfCancelled(isCancelled);
      }
    }

    term.sendText("\x1b[201~", false);
    pasteClosed = true;
  } catch (error) {
    if (!pasteClosed) {
      try { term.sendText("\x1b[201~", false); } catch { /* best effort */ }
    }
    throw error;
  }
}
