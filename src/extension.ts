import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { OperationCancelled, sendChunked, normalizeText, sleep } from "./chunker";
import { serializeBlocks, type ContentBlock } from "./serializer";

let activePanel: vscode.WebviewPanel | null = null;
const terminalIds = new WeakMap<vscode.Terminal, string>();
let nextTerminalId = 1;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-paste.openPanel", () => {
      openPastePanel(context);
    })
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayName(term: vscode.Terminal): string {
  const all = vscode.window.terminals;
  const sameName = all.filter((t) => t.name === term.name);
  if (sameName.length <= 1) return term.name;
  const idx = sameName.indexOf(term) + 1;
  return `${term.name} #${idx}`;
}

function terminalId(term: vscode.Terminal): string {
  let id = terminalIds.get(term);
  if (!id) {
    id = String(nextTerminalId++);
    terminalIds.set(term, id);
  }
  return id;
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

function getImageStorageDir(): string | undefined {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return undefined;
  return path.join(wsFolder.uri.fsPath, ".claude-paste-images");
}

async function saveClipboardImage(dataUri: string, mimeType: string): Promise<string | undefined> {
  const storageDir = getImageStorageDir();
  if (!storageDir) {
    vscode.window.showErrorMessage("No workspace folder open. Cannot save pasted image.");
    return undefined;
  }

  // Ensure directory exists
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
    // Create .gitignore
    const gitignorePath = path.join(storageDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf8");
    }
  }

  // Determine extension from mime
  let ext = ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = ".jpg";
  else if (mimeType.includes("gif")) ext = ".gif";
  else if (mimeType.includes("webp")) ext = ".webp";

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `paste-${timestamp}${ext}`;
  const filePath = path.join(storageDir, fileName);

  // Decode base64 data URI
  const base64Data = dataUri.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

async function readImageAsDataUri(filePath: string): Promise<string | undefined> {
  try {
    const buffer = fs.readFileSync(filePath);
    const mime = getMimeType(filePath);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

// ── Panel ────────────────────────────────────────────────────────────────

function openPastePanel(context: vscode.ExtensionContext) {
  const initialTerminal = vscode.window.activeTerminal;

  if (!initialTerminal) {
    vscode.window.showWarningMessage("No active terminal. Open a terminal first.");
    return;
  }

  if (activePanel) {
    activePanel.dispose();
    activePanel = null;
  }

  const panel = vscode.window.createWebviewPanel(
    "claude-paste",
    `Claude Paste → ${displayName(initialTerminal)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel = panel;

  // Per-terminal drafts stored as serialized HTML
  const drafts = new Map<vscode.Terminal, string>();
  const terminalsById = new Map<string, vscode.Terminal>();
  const rememberTerminal = (term: vscode.Terminal) => {
    const id = terminalId(term);
    terminalsById.set(id, term);
    return id;
  };

  panel.webview.html = getWebviewHtml(
    "",
    displayName(initialTerminal),
    rememberTerminal(initialTerminal)
  );

  let isSubmitting = false;
  let isCancelled = false;

  const changeDisposable = vscode.window.onDidChangeActiveTerminal((term) => {
    if (isCancelled || isSubmitting) return;
    if (term) {
      const name = displayName(term);
      const id = rememberTerminal(term);
      const content = drafts.get(term) ?? "";
      panel.title = `Claude Paste → ${name}`;
      panel.webview.postMessage({ type: "terminalSwitched", content, name, terminalId: id });
    }
  });

  const closeDisposable = vscode.window.onDidCloseTerminal((closedTerm) => {
    drafts.delete(closedTerm);
    const id = terminalIds.get(closedTerm);
    if (id) {
      terminalsById.delete(id);
    }
  });

  const msgDisposable = panel.webview.onDidReceiveMessage(async (msg) => {
    // --- CANCEL ---
    if (msg.type === "cancel") {
      isCancelled = true;
      panel.dispose();
      return;
    }

    if (isSubmitting) return;

    // --- DRAFT CHANGED ---
    if (msg.type === "draftChanged") {
      const draftTerm = terminalsById.get(msg.terminalId);
      if (draftTerm && !draftTerm.exitStatus) {
        drafts.set(draftTerm, msg.html || "");
      }
      return;
    }

    // --- BROWSE FILES ---
    if (msg.type === "browseFiles") {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        openLabel: "Insert Path",
        title: "Select files or folders to insert",
      });

      if (!selected || selected.length === 0) {
        return;
      }

      // Separate image files from non-image files
      const imagePaths: Array<{ path: string; dataUri: string; fileName: string }> = [];
      const textPaths: string[] = [];

      for (const uri of selected) {
        const filePath = uri.fsPath;
        if (isImageFile(filePath)) {
          const dataUri = await readImageAsDataUri(filePath);
          if (dataUri) {
            imagePaths.push({
              path: filePath,
              dataUri,
              fileName: path.basename(filePath),
            });
          } else {
            textPaths.push(filePath);
          }
        } else {
          textPaths.push(filePath);
        }
      }

      // Send non-image file paths as text
      if (textPaths.length > 0) {
        panel.webview.postMessage({
          type: "insertFilePaths",
          paths: textPaths,
        });
      }

      // Send image files with previews
      if (imagePaths.length > 0) {
        panel.webview.postMessage({
          type: "insertImages",
          images: imagePaths,
        });
      }
      return;
    }

    // --- CLIPBOARD IMAGE PASTE ---
    if (msg.type === "imagePasted") {
      const { dataUri, mimeType } = msg;
      const savedPath = await saveClipboardImage(dataUri, mimeType);
      if (savedPath) {
        panel.webview.postMessage({
          type: "insertImages",
          images: [{
            path: savedPath,
            dataUri,
            fileName: path.basename(savedPath),
          }],
        });
      }
      return;
    }

    // --- SUBMIT ---
    if (msg.type === "submit") {
      const blocks: ContentBlock[] = msg.blocks || [];
      const text = normalizeText(serializeBlocks(blocks));

      // Resolve target at submit time
      const term = vscode.window.activeTerminal;
      if (!term) {
        vscode.window.showErrorMessage("No active terminal.");
        return;
      }
      if (term.exitStatus) {
        vscode.window.showErrorMessage(`Terminal "${displayName(term)}" has closed.`);
        return;
      }

      isSubmitting = true;
      panel.webview.postMessage({ type: "status", text: "Inserting..." });

      if (text.length === 0) {
        drafts.delete(term);
        term.show();
        panel.dispose();
        return;
      }

      try {
        if (term.exitStatus) {
          isSubmitting = false;
          vscode.window.showErrorMessage(`Terminal "${displayName(term)}" has closed.`);
          return;
        }
        await sendChunked(term, text, () => isCancelled);
      } catch (error) {
        if (error instanceof OperationCancelled) {
          return;
        }
        vscode.window.showErrorMessage("Failed to paste — terminal may have closed.");
        panel.dispose();
        return;
      }

      drafts.delete(term);
      term.show();
      panel.webview.postMessage({ type: "status", text: "Done" });
      await sleep(150);
      panel.dispose();
    }
  });

  panel.onDidDispose(() => {
    isCancelled = true;
    changeDisposable.dispose();
    closeDisposable.dispose();
    msgDisposable.dispose();
    if (activePanel === panel) activePanel = null;
  });
}

// ── Webview HTML ─────────────────────────────────────────────────────────

function getWebviewHtml(initialContent: string, terminalName: string, tid: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Paste</title>
<style>
  :root {
    --cp-radius: 6px;
    --cp-transition: 150ms ease;
    --cp-gap: 10px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 14px 16px;
    overflow: hidden;
  }

  /* ── Header ─────────────────────────────── */

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    margin-bottom: 10px;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .header h2 {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    opacity: 0.88;
  }

  .header-icon {
    font-size: 15px;
    opacity: 0.7;
  }

  .target {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.7;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 10px;
    border-radius: 99px;
    letter-spacing: 0.01em;
  }

  /* ── Status ─────────────────────────────── */

  #status {
    display: none;
    text-align: center;
    padding: 10px;
    font-size: 12px;
    font-weight: 500;
    opacity: 0.85;
    flex-shrink: 0;
    border-radius: var(--cp-radius);
    margin-bottom: 6px;
    background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent);
  }
  #status.active { display: block; }

  /* ── Editor ─────────────────────────────── */

  #editor {
    flex: 1;
    width: 100%;
    min-height: 0;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-panel-border) 50%, transparent));
    border-radius: var(--cp-radius);
    padding: 12px 14px;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, 'Cascadia Code', Consolas, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.65;
    outline: none;
    overflow-y: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    cursor: text;
    transition: border-color var(--cp-transition), box-shadow var(--cp-transition);
  }

  #editor:focus {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent);
  }

  #editor:empty::before {
    content: 'Paste your content here…';
    color: var(--vscode-input-placeholderForeground, color-mix(in srgb, var(--vscode-editor-foreground) 35%, transparent));
    pointer-events: none;
    font-style: italic;
  }

  #editor.disabled {
    opacity: 0.45;
    pointer-events: none;
  }

  /* Custom scrollbar */
  #editor::-webkit-scrollbar { width: 8px; }
  #editor::-webkit-scrollbar-track { background: transparent; }
  #editor::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
    border-radius: 99px;
  }
  #editor::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--vscode-editor-foreground) 30%, transparent);
  }

  /* ── Image Block (preview mode) ────────── */

  .image-block {
    display: block;
    margin: 8px 0;
    border-radius: var(--cp-radius);
    border: 1px solid var(--vscode-panel-border);
    overflow: hidden;
    user-select: none;
    transition: border-color var(--cp-transition), box-shadow var(--cp-transition);
    animation: cp-fade-in 200ms ease-out;
    background: color-mix(in srgb, var(--vscode-editor-background) 60%, var(--vscode-input-background));
  }

  .image-block:hover {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent);
  }

  .image-block-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 500;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent);
  }

  .image-block-icon { font-size: 13px; flex-shrink: 0; }

  .image-block-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
  }

  .image-block-remove {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--vscode-editor-foreground);
    opacity: 0.35;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 3px;
    transition: opacity var(--cp-transition), background var(--cp-transition);
  }
  .image-block-remove:hover {
    opacity: 0.9;
    background: color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent);
  }

  .image-block-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    max-height: 280px;
    overflow: hidden;
    background: color-mix(in srgb, var(--vscode-editor-foreground) 3%, transparent);
  }

  .image-block-preview img {
    max-width: 100%;
    max-height: 280px;
    object-fit: contain;
    display: block;
  }

  .image-block-footer {
    padding: 5px 10px;
    font-size: 10px;
    opacity: 0.45;
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent);
  }

  /* ── Image Chip (path-only mode) ───────── */

  .image-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 2px 1px;
    padding: 2px 8px 2px 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 99px;
    font-size: 11px;
    font-family: var(--vscode-font-family, sans-serif);
    font-weight: 500;
    user-select: none;
    white-space: nowrap;
    vertical-align: middle;
    animation: cp-fade-in 150ms ease-out;
    transition: opacity var(--cp-transition);
  }

  .image-chip:hover { opacity: 0.85; }

  .image-chip-icon { font-size: 11px; }

  .image-chip-name {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .image-chip-remove {
    background: none;
    border: none;
    color: inherit;
    opacity: 0.5;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 0 2px;
    margin-left: 2px;
    transition: opacity var(--cp-transition);
  }
  .image-chip-remove:hover { opacity: 1; }

  /* ── Footer ─────────────────────────────── */

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 10px;
    margin-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    flex-shrink: 0;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .footer .keys {
    font-size: 11px;
    opacity: 0.45;
    white-space: nowrap;
  }

  .footer .keys kbd {
    background: var(--vscode-keybindingLabel-background, color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent));
    border: 1px solid var(--vscode-keybindingLabel-border, color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent));
    border-radius: 3px;
    padding: 1px 5px;
    font-family: inherit;
    font-size: 10px;
  }

  .stat {
    font-size: 11px;
    opacity: 0.4;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ── Buttons ────────────────────────────── */

  button {
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: var(--cp-radius);
    padding: 4px 10px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    line-height: 18px;
    cursor: pointer;
    transition: background var(--cp-transition), opacity var(--cp-transition);
    white-space: nowrap;
  }

  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  button.toggle {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
    color: var(--vscode-editor-foreground);
    opacity: 0.6;
    font-size: 11px;
    padding: 3px 8px;
  }
  button.toggle:hover { opacity: 0.9; }
  button.toggle.active {
    opacity: 0.9;
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    border-color: var(--vscode-focusBorder);
  }

  button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  button:disabled {
    cursor: default;
    opacity: 0.4;
  }

  /* ── Animations ─────────────────────────── */

  @keyframes cp-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <span class="header-icon">📋</span>
      <h2>Claude Paste</h2>
    </div>
    <span class="target" id="target">${escapeHtml(terminalName)}</span>
  </div>

  <div id="status"></div>

  <div id="editor" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="false">${escapeHtml(initialContent)}</div>

  <div class="footer">
    <div class="footer-left">
      <button id="browse-files" class="secondary" type="button" title="Insert file or folder paths">Browse Files…</button>
      <button id="toggle-preview" class="toggle" type="button" title="Toggle image preview display">👁 Preview</button>
      <div class="keys">
        <kbd>⌘↵</kbd> Insert &nbsp;
        <kbd>Esc</kbd> Cancel
      </div>
    </div>
    <div class="footer-right">
      <span class="stat" id="char-count">0 chars</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const editor = document.getElementById('editor');
    const counter = document.getElementById('char-count');
    const status = document.getElementById('status');
    const target = document.getElementById('target');
    const browseFiles = document.getElementById('browse-files');
    const togglePreview = document.getElementById('toggle-preview');

    let currentTerminalId = ${JSON.stringify(tid)};
    let showPreview = true;
    let imageIdCounter = 0;

    editor.focus();
    placeCaretAtEnd(editor);

    // ── Utility ──────────────────────────────

    function placeCaretAtEnd(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function getTextContent() {
      // Extract text, treating image blocks/chips as their path
      let result = '';
      for (const node of editor.childNodes) {
        result += extractNodeText(node);
      }
      return result;
    }

    function extractNodeText(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent || '';
      }
      if (node instanceof HTMLElement) {
        if (node.dataset && node.dataset.path) {
          return node.dataset.path;
        }
        if (node.tagName === 'BR') {
          return '\\n';
        }
        // Recurse for other elements (e.g. div wrapping lines)
        let text = '';
        for (const child of node.childNodes) {
          text += extractNodeText(child);
        }
        // Add newline after block elements
        if (['DIV', 'P'].includes(node.tagName) && text.length > 0) {
          text += '\\n';
        }
        return text;
      }
      return '';
    }

    function extractBlocks() {
      const blocks = [];
      for (const node of editor.childNodes) {
        collectBlocks(node, blocks);
      }
      // Merge adjacent text blocks
      const merged = [];
      for (const block of blocks) {
        if (block.type === 'text' && merged.length > 0 && merged[merged.length - 1].type === 'text') {
          merged[merged.length - 1].text += block.text;
        } else {
          merged.push(block);
        }
      }
      return merged;
    }

    function collectBlocks(node, blocks) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (text.length > 0) {
          blocks.push({ type: 'text', text });
        }
        return;
      }
      if (node instanceof HTMLElement) {
        if (node.dataset && node.dataset.path &&
            (node.classList.contains('image-block') || node.classList.contains('image-chip'))) {
          blocks.push({
            type: 'image',
            path: node.dataset.path,
            fileName: node.dataset.filename || '',
          });
          return;
        }
        if (node.tagName === 'BR') {
          blocks.push({ type: 'text', text: '\\n' });
          return;
        }
        // Block element: recurse, then add newline
        const isBlock = ['DIV', 'P'].includes(node.tagName);
        for (const child of node.childNodes) {
          collectBlocks(child, blocks);
        }
        if (isBlock) {
          blocks.push({ type: 'text', text: '\\n' });
        }
      }
    }

    function updateCounter() {
      const text = getTextContent();
      const chars = [...text].length;
      const bytes = new TextEncoder().encode(text).length;
      if (bytes !== chars) {
        counter.textContent = chars + ' chars · ' + formatBytes(bytes);
      } else {
        counter.textContent = chars + ' chars';
      }
    }

    function formatBytes(b) {
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      return (b / 1048576).toFixed(1) + ' MB';
    }

    function notifyDraftChanged() {
      vscode.postMessage({
        type: 'draftChanged',
        html: editor.innerHTML,
        terminalId: currentTerminalId,
      });
    }

    // ── Image rendering ──────────────────────

    function createImageBlock(path, dataUri, fileName) {
      const id = 'img-' + (++imageIdCounter);

      if (showPreview && dataUri) {
        const block = document.createElement('div');
        block.className = 'image-block';
        block.contentEditable = 'false';
        block.dataset.path = path;
        block.dataset.filename = fileName;
        block.dataset.datauri = dataUri;
        block.id = id;
        block.innerHTML =
          '<div class="image-block-header">' +
            '<span class="image-block-icon">🖼</span>' +
            '<span class="image-block-name">' + escapeH(fileName) + '</span>' +
            '<button class="image-block-remove" title="Remove image">✕</button>' +
          '</div>' +
          '<div class="image-block-preview">' +
            '<img src="' + dataUri + '" alt="' + escapeH(fileName) + '" />' +
          '</div>' +
          '<div class="image-block-footer">' + escapeH(path) + '</div>';
        block.querySelector('.image-block-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          block.remove();
          updateCounter();
          notifyDraftChanged();
        });
        return block;
      } else {
        const chip = document.createElement('span');
        chip.className = 'image-chip';
        chip.contentEditable = 'false';
        chip.dataset.path = path;
        chip.dataset.filename = fileName;
        if (dataUri) chip.dataset.datauri = dataUri;
        chip.id = id;
        chip.innerHTML =
          '<span class="image-chip-icon">📎</span>' +
          '<span class="image-chip-name">' + escapeH(fileName) + '</span>' +
          '<button class="image-chip-remove" title="Remove">✕</button>';
        chip.title = path;
        chip.querySelector('.image-chip-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          chip.remove();
          updateCounter();
          notifyDraftChanged();
        });
        return chip;
      }
    }

    function escapeH(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function insertImageAtCaret(path, dataUri, fileName) {
      const block = createImageBlock(path, dataUri, fileName);
      const sel = window.getSelection();

      if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(block);
        // Move caret after the inserted block
        range.setStartAfter(block);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.appendChild(block);
      }

      // Ensure there's a text node after the image for continued typing
      if (!block.nextSibling || (block.nextSibling.nodeType !== Node.TEXT_NODE)) {
        const spacer = document.createTextNode('\\n');
        block.parentNode.insertBefore(spacer, block.nextSibling);
        // Place caret after spacer
        const r = document.createRange();
        r.setStartAfter(spacer);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }

      updateCounter();
      notifyDraftChanged();
    }

    function rebuildImageDisplay() {
      // Collect all image nodes, rebuild them with new display mode
      const imageNodes = editor.querySelectorAll('.image-block, .image-chip');
      for (const node of imageNodes) {
        const p = node.dataset.path;
        const f = node.dataset.filename;
        const d = node.dataset.datauri || '';
        const newNode = createImageBlock(p, d, f);
        node.replaceWith(newNode);
      }
    }

    // ── Event listeners ──────────────────────

    editor.addEventListener('input', () => {
      updateCounter();
      notifyDraftChanged();
    });

    // Handle paste — intercept image pastes
    editor.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      let hasImage = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type && item.type.startsWith('image/')) {
          hasImage = true;
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = function(ev) {
            const dataUri = ev.target.result;
            // Send to extension to save as file, then we'll get the path back
            vscode.postMessage({
              type: 'imagePasted',
              dataUri: dataUri,
              mimeType: item.type,
            });
          };
          reader.readAsDataURL(file);
          break;  // One image at a time
        }
      }

      if (!hasImage) {
        // For text paste, ensure plain text only
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        if (text) {
          document.execCommand('insertText', false, text);
        }
      }
    });

    // Prevent drag-and-drop (VS Code webview limitation)
    editor.addEventListener('dragover', (e) => e.preventDefault());
    editor.addEventListener('drop', (e) => e.preventDefault());

    // Browse files button
    browseFiles.addEventListener('click', () => {
      vscode.postMessage({ type: 'browseFiles' });
    });

    // Toggle preview button
    togglePreview.addEventListener('click', () => {
      showPreview = !showPreview;
      togglePreview.classList.toggle('active', showPreview);
      rebuildImageDisplay();
    });
    // Initialize toggle state
    togglePreview.classList.toggle('active', showPreview);

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        const blocks = extractBlocks();
        vscode.postMessage({ type: 'submit', blocks });
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        vscode.postMessage({ type: 'cancel' });
      }
    });

    // Handle messages from extension
    window.addEventListener('message', (e) => {
      const msg = e.data;

      if (msg.type === 'terminalSwitched') {
        currentTerminalId = msg.terminalId;
        editor.innerHTML = msg.content || '';
        target.textContent = msg.name;
        // Re-attach remove listeners to any image blocks
        reattachImageListeners();
        updateCounter();
        editor.focus();
        placeCaretAtEnd(editor);
      }

      if (msg.type === 'insertFilePaths') {
        const paths = Array.isArray(msg.paths)
          ? msg.paths.filter((p) => typeof p === 'string' && p.length > 0)
          : [];
        if (paths.length > 0) {
          // Insert as text at caret
          document.execCommand('insertText', false, paths.join(' '));
          updateCounter();
          notifyDraftChanged();
        }
        editor.focus();
      }

      if (msg.type === 'insertImages') {
        const images = msg.images || [];
        for (const img of images) {
          insertImageAtCaret(img.path, img.dataUri, img.fileName);
        }
        editor.focus();
      }

      if (msg.type === 'status') {
        status.textContent = msg.text;
        status.className = 'active';
        if (msg.text === 'Done') {
          status.style.color = 'var(--vscode-terminal-ansiGreen, #4ec9b0)';
        } else {
          status.style.color = '';
        }
        editor.classList.add('disabled');
        browseFiles.disabled = true;
        togglePreview.disabled = true;
      }

      if (msg.type === 'resetStatus') {
        status.className = '';
        editor.classList.remove('disabled');
        browseFiles.disabled = false;
        togglePreview.disabled = false;
      }
    });

    function reattachImageListeners() {
      editor.querySelectorAll('.image-block-remove, .image-chip-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const block = btn.closest('.image-block') || btn.closest('.image-chip');
          if (block) {
            block.remove();
            updateCounter();
            notifyDraftChanged();
          }
        });
      });
    }

    // Initial counter
    updateCounter();
  </script>
</body>
</html>`;
}
