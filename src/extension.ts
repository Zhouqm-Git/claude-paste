import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import * as os from "os";
import { OperationCancelled, sendChunked, normalizeText, sleep } from "./chunker";

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
    case ".png":  return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif":  return "image/gif";
    case ".webp": return "image/webp";
    default:      return "application/octet-stream";
  }
}

function getImageStorageDir(): string | undefined {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return undefined;
  return path.join(wsFolder.uri.fsPath, ".claude-paste-images");
}

function ensureStorageDir(storageDir: string): void {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
    const gitignorePath = path.join(storageDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf8");
    }
  }
}

// ── Clipboard image grab ─────────────────────────────────────────────────

/**
 * Try to grab an image from the system clipboard and save it.
 * Uses built-in macOS osascript (no brew install needed), with pngpaste as fast fallback.
 */
async function pasteImageFromClipboard(): Promise<string | undefined> {
  const storageDir = getImageStorageDir();
  if (!storageDir) return undefined;
  ensureStorageDir(storageDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `paste-${timestamp}.png`;
  const filePath = path.join(storageDir, fileName);

  // Method 1: pngpaste (fast, if installed)
  if (tryPngPaste(filePath)) return filePath;

  // Method 2: osascript + AppKit bridge (built-in on macOS, no install needed)
  if (tryOsascriptAppKit(filePath)) return filePath;

  // Method 3: xclip (Linux)
  if (tryXclip(filePath)) return filePath;

  // Method 4: PowerShell (Windows)
  if (tryPowerShell(filePath)) return filePath;

  // Cleanup empty file if any method created one
  try { if (fs.existsSync(filePath) && fs.statSync(filePath).size === 0) fs.unlinkSync(filePath); } catch {}

  return undefined;
}

function tryPngPaste(outputPath: string): boolean {
  try {
    child_process.execSync(`pngpaste "${outputPath}" 2>/dev/null`, { timeout: 3000 });
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

function tryOsascriptAppKit(outputPath: string): boolean {
  // Use AppleScript with Objective-C bridge — built into macOS, no external tools
  const script = `
use framework "AppKit"
set pb to current application's NSPasteboard's generalPasteboard()
set imgClasses to {current application's NSImage}
if (pb's canReadObjectForClasses:imgClasses options:(missing value)) then
  set imgList to (pb's readObjectsForClasses:imgClasses options:(missing value))
  set img to item 1 of imgList
  set tiffData to img's TIFFRepresentation()
  set rep to (current application's NSBitmapImageRep's imageRepWithData:tiffData)
  set pngData to (rep's representationUsingType:(current application's NSBitmapImageTypePNG) properties:(missing value))
  pngData's writeToFile:"${outputPath}" atomically:true
  return "ok"
else
  return "no_image"
end if
`;
  try {
    const result = child_process.spawnSync("osascript", ["-"], {
      input: script,
      timeout: 5000,
      encoding: "utf8",
    });
    const output = (result.stdout || "").trim();
    if (output === "ok" && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return true;
    }
  } catch {}
  return false;
}

function tryXclip(outputPath: string): boolean {
  try {
    child_process.execSync(
      `xclip -selection clipboard -t image/png -o > "${outputPath}" 2>/dev/null`,
      { timeout: 3000, shell: "/bin/bash" }
    );
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

function tryPowerShell(outputPath: string): boolean {
  try {
    const psScript = `
$img = Get-Clipboard -Format Image
if ($img) {
  $img.Save('${outputPath.replace(/'/g, "''")}')
  Write-Output 'ok'
} else {
  Write-Output 'no_image'
}`;
    const result = child_process.execSync(`powershell -Command "${psScript}"`, { timeout: 5000 }).toString().trim();
    return result === "ok" && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
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
        drafts.set(draftTerm, msg.text || "");
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

      if (!selected || selected.length === 0) return;

      const paths: string[] = [];
      const imagePreviews: Array<{ path: string; dataUri: string; fileName: string }> = [];

      for (const uri of selected) {
        const filePath = uri.fsPath;
        paths.push(filePath);
        if (isImageFile(filePath)) {
          const dataUri = await readImageAsDataUri(filePath);
          if (dataUri) {
            imagePreviews.push({ path: filePath, dataUri, fileName: path.basename(filePath) });
          }
        }
      }

      panel.webview.postMessage({ type: "insertFilePaths", paths, imagePreviews });
      return;
    }

    // --- CHECK CLIPBOARD FOR IMAGE (auto-triggered on paste) ---
    if (msg.type === "checkClipboardImage") {
      const savedPath = await pasteImageFromClipboard();
      if (savedPath) {
        const dataUri = await readImageAsDataUri(savedPath);
        panel.webview.postMessage({
          type: "clipboardImageResult",
          found: true,
          path: savedPath,
          dataUri: dataUri || "",
          fileName: path.basename(savedPath),
        });
      } else {
        panel.webview.postMessage({ type: "clipboardImageResult", found: false });
      }
      return;
    }

    // --- RESOLVE IMAGE PREVIEWS (from text scanning) ---
    if (msg.type === "resolveImages") {
      const imagePaths: string[] = msg.paths || [];
      const results: Array<{ path: string; dataUri: string; fileName: string }> = [];

      for (const imgPath of imagePaths) {
        const resolved = imgPath.startsWith("~")
          ? imgPath.replace("~", process.env.HOME || "")
          : imgPath;
        if (fs.existsSync(resolved) && isImageFile(resolved)) {
          const dataUri = await readImageAsDataUri(resolved);
          if (dataUri) {
            results.push({ path: imgPath, dataUri, fileName: path.basename(imgPath) });
          }
        }
      }

      panel.webview.postMessage({ type: "imagePreviewsResolved", images: results });
      return;
    }

    // --- SUBMIT ---
    if (msg.type === "submit") {
      const text = normalizeText(msg.text || "");

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
  const escaped = escapeHtml(initialContent);
  const charCount = [...initialContent].length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Paste</title>
<style>
  :root {
    --cp-radius: 6px;
    --cp-transition: 150ms ease;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 14px 16px;
    overflow: hidden;
  }

  /* ── Header ────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    margin-bottom: 10px;
    flex-shrink: 0;
  }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .header h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; opacity: 0.88; }
  .header-icon { font-size: 15px; opacity: 0.7; }
  .target {
    font-size: 11px; font-weight: 500; opacity: 0.7;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 10px; border-radius: 99px;
  }

  /* ── Status ────────── */
  #status {
    display: none; text-align: center; padding: 8px;
    font-size: 12px; font-weight: 500; opacity: 0.85;
    flex-shrink: 0; border-radius: var(--cp-radius); margin-bottom: 6px;
    background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent);
  }
  #status.active { display: block; }

  /* ── Image Preview Strip ─── */
  #image-strip {
    display: none; flex-shrink: 0; max-height: 260px; overflow-y: auto;
    margin-bottom: 8px; border-radius: var(--cp-radius);
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 60%, var(--vscode-input-background));
  }
  #image-strip.visible { display: block; }
  #image-strip::-webkit-scrollbar { width: 6px; }
  #image-strip::-webkit-scrollbar-track { background: transparent; }
  #image-strip::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent);
    border-radius: 99px;
  }

  .img-card {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 30%, transparent);
    animation: cp-slide-in 200ms ease-out;
  }
  .img-card:last-child { border-bottom: none; }

  .img-card-thumb {
    width: 48px; height: 48px; border-radius: 4px;
    object-fit: cover; flex-shrink: 0; cursor: pointer;
    background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent);
    transition: transform var(--cp-transition);
  }
  .img-card-thumb:hover { transform: scale(1.05); }

  .img-card-info { flex: 1; min-width: 0; overflow: hidden; }
  .img-card-name {
    font-size: 12px; font-weight: 500; opacity: 0.85;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .img-card-path {
    font-size: 10px; opacity: 0.4; margin-top: 2px;
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .img-card-remove {
    flex-shrink: 0; background: none; border: none;
    color: var(--vscode-editor-foreground); opacity: 0.3;
    cursor: pointer; font-size: 14px; padding: 4px 6px; border-radius: 4px;
    transition: opacity var(--cp-transition), background var(--cp-transition);
  }
  .img-card-remove:hover {
    opacity: 0.85;
    background: color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent);
  }

  /* Expanded preview */
  .img-expanded-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.7); display: flex;
    align-items: center; justify-content: center;
    cursor: pointer; animation: cp-fade-in 150ms ease-out;
  }
  .img-expanded-overlay img {
    max-width: 90%; max-height: 90%; object-fit: contain;
    border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }

  /* ── Textarea ──────── */
  #input {
    flex: 1; width: 100%; min-height: 0;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-panel-border) 50%, transparent));
    border-radius: var(--cp-radius); padding: 12px 14px;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.65; resize: none; outline: none;
    transition: border-color var(--cp-transition), box-shadow var(--cp-transition);
  }
  #input:focus {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent);
  }
  #input::placeholder {
    color: var(--vscode-input-placeholderForeground, color-mix(in srgb, var(--vscode-editor-foreground) 35%, transparent));
    font-style: italic;
  }
  #input.disabled { opacity: 0.45; pointer-events: none; }
  #input::-webkit-scrollbar { width: 8px; }
  #input::-webkit-scrollbar-track { background: transparent; }
  #input::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
    border-radius: 99px;
  }
  #input::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--vscode-editor-foreground) 30%, transparent);
  }

  /* Paste hint toast */
  #paste-toast {
    display: none; position: fixed; bottom: 80px; left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 6px 14px; border-radius: 99px;
    font-size: 11px; font-weight: 500; opacity: 0;
    transition: opacity 200ms ease;
    z-index: 50; pointer-events: none;
  }
  #paste-toast.show { display: block; opacity: 1; }

  /* ── Footer ────────── */
  .footer {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding-top: 10px; margin-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    flex-shrink: 0;
  }
  .footer-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .footer-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .footer .keys { font-size: 11px; opacity: 0.45; white-space: nowrap; }
  .footer .keys kbd {
    background: var(--vscode-keybindingLabel-background, color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent));
    border: 1px solid var(--vscode-keybindingLabel-border, color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent));
    border-radius: 3px; padding: 1px 5px; font-family: inherit; font-size: 10px;
  }
  .stat { font-size: 11px; opacity: 0.4; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* ── Buttons ───────── */
  button {
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: var(--cp-radius); padding: 4px 10px;
    font-family: inherit; font-size: 11px; font-weight: 500;
    line-height: 18px; cursor: pointer;
    transition: background var(--cp-transition), opacity var(--cp-transition);
    white-space: nowrap;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.toggle {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
    color: var(--vscode-editor-foreground); opacity: 0.55;
    font-size: 11px; padding: 3px 8px;
  }
  button.toggle:hover { opacity: 0.85; }
  button.toggle.active {
    opacity: 0.9;
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    border-color: var(--vscode-focusBorder);
  }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: 0.4; }

  @keyframes cp-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes cp-slide-in {
    from { opacity: 0; transform: translateY(-6px); }
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
  <div id="image-strip"></div>
  <div id="paste-toast">Checking clipboard for image…</div>

  <textarea id="input" placeholder="Paste your content here… (text and images are both supported)" autofocus>${escaped}</textarea>

  <div class="footer">
    <div class="footer-left">
      <button id="browse-files" class="secondary" type="button" title="Insert file or folder paths at cursor">Browse Files…</button>
      <button id="toggle-preview" class="toggle" type="button" title="Toggle image preview display">👁 Preview</button>
      <div class="keys">
        <kbd>⌘↵</kbd> Insert &nbsp;
        <kbd>Esc</kbd> Cancel
      </div>
    </div>
    <div class="footer-right">
      <span class="stat" id="char-count">${charCount} chars</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('input');
    const counter = document.getElementById('char-count');
    const status = document.getElementById('status');
    const target = document.getElementById('target');
    const imageStrip = document.getElementById('image-strip');
    const browseFiles = document.getElementById('browse-files');
    const togglePreview = document.getElementById('toggle-preview');
    const pasteToast = document.getElementById('paste-toast');

    let currentTerminalId = ${JSON.stringify(tid)};
    let showPreview = true;
    let lastSelectionStart = input.value.length;
    let lastSelectionEnd = input.value.length;
    let scanTimer = null;
    let toastTimer = null;

    // Image previews: path -> { dataUri, fileName }
    const imagePreviews = new Map();

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    togglePreview.classList.toggle('active', showPreview);

    // ── Utility ──────────────────────────────

    function updateCounter() {
      const text = input.value;
      const chars = [...text].length;
      const bytes = new TextEncoder().encode(text).length;
      counter.textContent = bytes !== chars
        ? chars + ' chars \\u00b7 ' + formatBytes(bytes)
        : chars + ' chars';
    }

    function formatBytes(b) {
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      return (b / 1048576).toFixed(1) + ' MB';
    }

    function rememberSelection() {
      lastSelectionStart = input.selectionStart;
      lastSelectionEnd = input.selectionEnd;
    }

    function notifyDraftChanged() {
      vscode.postMessage({ type: 'draftChanged', text: input.value, terminalId: currentTerminalId });
    }

    function insertAtCursor(text) {
      const start = Math.max(0, Math.min(lastSelectionStart, input.value.length));
      const end = Math.max(start, Math.min(lastSelectionEnd, input.value.length));

      // Ensure we're on a new line for image paths
      let prefix = '';
      if (start > 0 && input.value[start - 1] !== '\\n') {
        prefix = '\\n';
      }
      let suffix = '';
      if (end < input.value.length && input.value[end] !== '\\n') {
        suffix = '\\n';
      }

      const insertion = prefix + text + suffix;
      input.value = input.value.slice(0, start) + insertion + input.value.slice(end);
      const cursor = start + insertion.length;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      rememberSelection();
      updateCounter();
      notifyDraftChanged();
      scheduleScanForImages();
    }

    function insertTextAtSelection(text) {
      const start = Math.max(0, Math.min(lastSelectionStart, input.value.length));
      const end = Math.max(start, Math.min(lastSelectionEnd, input.value.length));
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const cursor = start + text.length;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      rememberSelection();
      updateCounter();
      notifyDraftChanged();
      scheduleScanForImages();
    }

    function showToast(msg, duration) {
      pasteToast.textContent = msg;
      pasteToast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => pasteToast.classList.remove('show'), duration || 2000);
    }

    function escapeH(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    // ── Image path scanning ──────────────────

    const IMG_RE = /(?:^|[\\s])((?:\\/|\\.\\/|~\\/)[^\\s]+\\.(?:png|jpe?g|gif|webp))(?=[\\s]|$)/gim;

    function scanImagePaths() {
      const text = input.value;
      const paths = [];
      let m;
      IMG_RE.lastIndex = 0;
      while ((m = IMG_RE.exec(text)) !== null) {
        paths.push(m[1]);
      }
      const unknown = paths.filter(p => !imagePreviews.has(p));
      if (unknown.length > 0) {
        vscode.postMessage({ type: 'resolveImages', paths: unknown });
      }
      renderImageStrip(paths);
    }

    function scheduleScanForImages() {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanImagePaths, 400);
    }

    // ── Image strip rendering ────────────────

    function renderImageStrip(paths) {
      if (!showPreview || paths.length === 0) {
        imageStrip.innerHTML = '';
        imageStrip.classList.remove('visible');
        return;
      }
      const visible = paths.filter(p => imagePreviews.has(p));
      if (visible.length === 0) {
        imageStrip.innerHTML = '';
        imageStrip.classList.remove('visible');
        return;
      }

      imageStrip.innerHTML = visible.map(p => {
        const info = imagePreviews.get(p);
        return '<div class="img-card" data-path="' + escapeH(p) + '">' +
          '<img class="img-card-thumb" src="' + info.dataUri + '" alt="' + escapeH(info.fileName) + '" title="Click to enlarge" />' +
          '<div class="img-card-info">' +
            '<div class="img-card-name">' + escapeH(info.fileName) + '</div>' +
            '<div class="img-card-path">' + escapeH(p) + '</div>' +
          '</div>' +
          '<button class="img-card-remove" title="Remove from text">\\u2715</button>' +
        '</div>';
      }).join('');

      imageStrip.classList.add('visible');

      imageStrip.querySelectorAll('.img-card-thumb').forEach(thumb => {
        thumb.addEventListener('click', () => showExpandedImage(thumb.src, thumb.alt));
      });
      imageStrip.querySelectorAll('.img-card-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('.img-card');
          const imgPath = card.dataset.path;
          removePathFromTextarea(imgPath);
          imagePreviews.delete(imgPath);
          scheduleScanForImages();
        });
      });
    }

    function removePathFromTextarea(imgPath) {
      const esc = imgPath.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const re = new RegExp('\\\\n?' + esc + '\\\\n?', 'g');
      input.value = input.value.replace(re, '\\n').replace(/^\\n+|\\n+$/g, '');
      updateCounter();
      notifyDraftChanged();
    }

    function showExpandedImage(src, alt) {
      const overlay = document.createElement('div');
      overlay.className = 'img-expanded-overlay';
      overlay.innerHTML = '<img src="' + src + '" alt="' + escapeH(alt || '') + '" />';
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    }

    // ── Paste handler: auto-detect images ────

    input.addEventListener('paste', (e) => {
      // Check if this paste contains text
      const textData = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';

      if (textData.length === 0) {
        // No text pasted → likely an image in clipboard
        // Prevent default (nothing useful would happen anyway)
        e.preventDefault();
        showToast('Checking clipboard for image…', 3000);
        vscode.postMessage({ type: 'checkClipboardImage' });
      }
      // If text exists, let textarea handle it normally (v1 behavior preserved)
    });

    // ── Event listeners ──────────────────────

    input.addEventListener('input', () => {
      rememberSelection();
      updateCounter();
      notifyDraftChanged();
      scheduleScanForImages();
    });
    input.addEventListener('click', rememberSelection);
    input.addEventListener('keyup', rememberSelection);
    input.addEventListener('select', rememberSelection);
    input.addEventListener('focus', rememberSelection);

    browseFiles.addEventListener('mousedown', rememberSelection);
    browseFiles.addEventListener('click', () => {
      rememberSelection();
      vscode.postMessage({ type: 'browseFiles' });
    });

    togglePreview.addEventListener('click', () => {
      showPreview = !showPreview;
      togglePreview.classList.toggle('active', showPreview);
      scanImagePaths();
    });

    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        vscode.postMessage({ type: 'submit', text: input.value });
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        vscode.postMessage({ type: 'cancel' });
      }
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;

      if (msg.type === 'terminalSwitched') {
        currentTerminalId = msg.terminalId;
        input.value = msg.content;
        target.textContent = msg.name;
        updateCounter();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        rememberSelection();
        imagePreviews.clear();
        scheduleScanForImages();
      }

      if (msg.type === 'insertFilePaths') {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter(p => typeof p === 'string' && p.length > 0) : [];
        if (paths.length > 0) {
          insertTextAtSelection(paths.join(' '));
        } else {
          input.focus();
        }
        const previews = msg.imagePreviews || [];
        for (const img of previews) {
          imagePreviews.set(img.path, { dataUri: img.dataUri, fileName: img.fileName });
        }
        if (previews.length > 0) scheduleScanForImages();
      }

      if (msg.type === 'clipboardImageResult') {
        pasteToast.classList.remove('show');
        if (msg.found) {
          // Image found in clipboard — insert its path
          insertAtCursor(msg.path);
          imagePreviews.set(msg.path, { dataUri: msg.dataUri, fileName: msg.fileName });
          scheduleScanForImages();
          showToast('Image pasted ✓', 1500);
        }
        // If not found, silently do nothing (user just pasted non-text non-image content)
      }

      if (msg.type === 'imagePreviewsResolved') {
        const images = msg.images || [];
        for (const img of images) {
          imagePreviews.set(img.path, { dataUri: img.dataUri, fileName: img.fileName });
        }
        scanImagePaths();
      }

      if (msg.type === 'status') {
        status.textContent = msg.text;
        status.className = 'active';
        status.style.color = msg.text === 'Done'
          ? 'var(--vscode-terminal-ansiGreen, #4ec9b0)' : '';
        input.classList.add('disabled');
        browseFiles.disabled = true;
        togglePreview.disabled = true;
      }

      if (msg.type === 'resetStatus') {
        status.className = '';
        input.classList.remove('disabled');
        browseFiles.disabled = false;
        togglePreview.disabled = false;
      }
    });

    updateCounter();
    scheduleScanForImages();
  </script>
</body>
</html>`;
}
