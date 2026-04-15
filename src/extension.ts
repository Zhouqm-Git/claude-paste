import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import * as os from "os";

// Debug output channel
let outputChannel: vscode.OutputChannel;
function log(msg: string) {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel("Claude Paste");
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}
import { OperationCancelled, sendChunked, normalizeText, sleep } from "./chunker";

let activePanel: vscode.WebviewPanel | null = null;
const terminalIds = new WeakMap<vscode.Terminal, string>();
let nextTerminalId = 1;

export function activate(context: vscode.ExtensionContext) {
  // Create output channel immediately so it's visible in Output panel
  outputChannel = vscode.window.createOutputChannel("Claude Paste");
  log("Claude Paste extension activated");

  context.subscriptions.push(
    outputChannel,
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

  log(`Attempting clipboard image grab → ${filePath}`);

  // Method 1: pngpaste (fast, if installed)
  if (tryPngPaste(filePath)) return filePath;

  // Method 2: osascript + JXA (built-in on macOS, no install needed)
  if (tryOsascriptJXA(filePath)) return filePath;

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
    const ok = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
    log(`pngpaste: ${ok ? 'success' : 'no image'}`);
    return ok;
  } catch (e) {
    log(`pngpaste: not available (${e instanceof Error ? e.message : e})`);
    return false;
  }
}

function tryOsascriptJXA(outputPath: string): boolean {
  // Use JXA (JavaScript for Automation) — built into macOS, no external tools
  // JXA avoids the encoding issues with AppleScript's «class PNGf» syntax
  const safePath = outputPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const script = [
    "ObjC.import('AppKit');",
    "var pb = $.NSPasteboard.generalPasteboard;",
    "",
    "// Try PNG first",
    "var data = pb.dataForType($.NSPasteboardTypePNG);",
    "if (data && !data.isNil()) {",
    `  data.writeToFileAtomically('${safePath}', true);`,
    "  'ok_png';",
    "} else {",
    "  // Try TIFF (screenshots, Preview copies, etc.) and convert to PNG",
    "  data = pb.dataForType($.NSPasteboardTypeTIFF);",
    "  if (data && !data.isNil()) {",
    "    var rep = $.NSBitmapImageRep.imageRepWithData(data);",
    "    if (rep && !rep.isNil()) {",
    "      var pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());",
    "      if (pngData && !pngData.isNil()) {",
    `        pngData.writeToFileAtomically('${safePath}', true);`,
    "        'ok_tiff_to_png';",
    "      } else { 'convert_failed'; }",
    "    } else { 'rep_failed'; }",
    "  } else { 'no_image'; }",
    "}",
  ].join("\n");

  try {
    const result = child_process.spawnSync("osascript", ["-l", "JavaScript", "-"], {
      input: script,
      timeout: 8000,
      encoding: "utf8",
    });
    const stdout = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();
    log(`osascript JXA: stdout=${stdout}, stderr=${stderr ? stderr.slice(0, 200) : '(none)'}`);

    if (stdout.startsWith("ok") && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      log(`osascript JXA: success, saved ${fs.statSync(outputPath).size} bytes`);
      return true;
    }
    log(`osascript JXA: no image (${stdout})`);
  } catch (e) {
    log(`osascript JXA: error (${e instanceof Error ? e.message : e})`);
  }
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

/**
 * Check if a string looks like an image URL.
 */
function isImageUrl(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  // Check URL path for image extension (ignore query params)
  try {
    const url = new URL(trimmed);
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url.pathname);
  } catch {
    return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(trimmed);
  }
}

/**
 * Download an image from a URL and save it locally.
 */
async function downloadImageFromUrl(imageUrl: string): Promise<string | undefined> {
  const storageDir = getImageStorageDir();
  if (!storageDir) return undefined;
  ensureStorageDir(storageDir);

  // Determine filename from URL
  let ext = ".png";
  try {
    const url = new URL(imageUrl);
    const urlPath = url.pathname;
    const match = urlPath.match(/\.(png|jpe?g|gif|webp)$/i);
    if (match) ext = match[0].toLowerCase();
  } catch {}

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `web-${timestamp}${ext}`;
  const filePath = path.join(storageDir, fileName);

  log(`Downloading image from URL: ${imageUrl}`);
  log(`Saving to: ${filePath}`);

  try {
    const result = child_process.spawnSync("curl", [
      "-sL",           // silent, follow redirects
      "--max-time", "10",  // 10 second timeout
      "-o", filePath,
      imageUrl,
    ], { timeout: 15000 });

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      log(`Download success: ${fs.statSync(filePath).size} bytes`);
      return filePath;
    }
    log(`Download failed: file empty or missing. stderr=${(result.stderr || "").toString().slice(0, 200)}`);
  } catch (e) {
    log(`Download error: ${e instanceof Error ? e.message : e}`);
  }

  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  return undefined;
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
      const pastedText = (msg.pastedText || "").trim();
      log(`checkClipboardImage: pastedText="${pastedText.slice(0, 100)}"`);

      // Strategy 1: Check native clipboard for image data (screenshots, etc.)
      const nativePath = await pasteImageFromClipboard();
      if (nativePath) {
        log(`Native clipboard image found: ${nativePath}`);
        const dataUri = await readImageAsDataUri(nativePath);
        panel.webview.postMessage({
          type: "clipboardImageResult",
          found: true,
          path: nativePath,
          dataUri: dataUri || "",
          fileName: path.basename(nativePath),
          replaceText: false,  // Don't replace, just add
        });
        return;
      }

      // Strategy 2: If pasted text is an image URL, download it
      if (isImageUrl(pastedText)) {
        log(`Pasted text is image URL, downloading: ${pastedText}`);
        const downloadedPath = await downloadImageFromUrl(pastedText);
        if (downloadedPath) {
          const dataUri = await readImageAsDataUri(downloadedPath);
          panel.webview.postMessage({
            type: "clipboardImageResult",
            found: true,
            path: downloadedPath,
            dataUri: dataUri || "",
            fileName: path.basename(downloadedPath),
            replaceText: true,  // Replace URL with local path
            originalText: pastedText,
          });
          return;
        }
      }

      log("No image found in clipboard or URL");
      panel.webview.postMessage({ type: "clipboardImageResult", found: false });
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

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Paste</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family);
    display: flex; flex-direction: column;
    height: 100vh; padding: 12px;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px;
  }
  .header h2 { font-size: 14px; font-weight: 600; opacity: 0.9; }
  .target {
    font-size: 12px; opacity: 0.6;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    padding: 2px 8px; border-radius: 10px;
  }
  #status { display: none; text-align: center; padding: 8px; font-size: 13px; opacity: 0.8; }
  #status.active { display: block; }
  #image-strip {
    display: none; max-height: 200px; overflow-y: auto; margin-bottom: 6px;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-input-background);
  }
  #image-strip.visible { display: block; }
  .img-card {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px;
  }
  .img-card:last-child { border-bottom: none; }
  .img-card-thumb { width: 40px; height: 40px; border-radius: 3px; object-fit: cover; flex-shrink: 0; cursor: pointer; }
  .img-card-info { flex: 1; min-width: 0; overflow: hidden; }
  .img-card-name { font-weight: 500; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .img-card-path { font-size: 10px; opacity: 0.4; margin-top: 1px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .img-card-remove { flex-shrink: 0; background: none; border: none; color: var(--vscode-editor-foreground); opacity: 0.3; cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 3px; }
  .img-card-remove:hover { opacity: 0.8; }
  .img-expanded-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .img-expanded-overlay img { max-width: 90%; max-height: 90%; object-fit: contain; border-radius: 6px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
  #paste-toast {
    display: none; position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    padding: 4px 12px; border-radius: 10px; font-size: 11px; opacity: 0;
    z-index: 50; pointer-events: none; transition: opacity 200ms ease;
  }
  #paste-toast.show { display: block; opacity: 1; }
  #input {
    flex: 1; width: 100%;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
    padding: 12px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px); line-height: 1.6;
    resize: none; outline: none;
  }
  #input:focus { border-color: var(--vscode-focusBorder); }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #input.disabled { opacity: 0.5; pointer-events: none; }
  .footer {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding-top: 8px; margin-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .footer-left { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; }
  .footer .keys { font-size: 12px; opacity: 0.5; }
  .footer .keys kbd {
    background: var(--vscode-keybindingLabel-background); border: 1px solid var(--vscode-keybindingLabel-border);
    border-radius: 3px; padding: 1px 5px; font-family: inherit; font-size: 11px;
  }
  button {
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
    padding: 4px 10px; font-family: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.toggle { background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-editor-foreground); opacity: 0.5; padding: 3px 8px; font-size: 11px; }
  button.toggle:hover { opacity: 0.8; }
  button.toggle.active { opacity: 0.9; border-color: var(--vscode-focusBorder); }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: 0.5; }
  #char-count { font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
  <div class="header">
    <h2>Claude Paste</h2>
    <span class="target" id="target">${escapeHtml(terminalName)}</span>
  </div>
  <div id="status"></div>
  <div id="image-strip"></div>
  <div id="paste-toast"></div>
  <textarea id="input" placeholder="Paste your content here..." autofocus>${escaped}</textarea>
  <div class="footer">
    <div class="footer-left">
      <button id="browse-files" class="secondary" type="button" title="Insert file or folder paths at cursor">Browse Files...</button>
      <button id="toggle-preview" class="toggle active" type="button" title="Toggle image preview">👁 Preview</button>
      <div class="keys">
        <kbd>Cmd+Enter</kbd> Insert &nbsp;
        <kbd>Esc</kbd> Cancel
      </div>
    </div>
    <span id="char-count">${charCount} chars</span>
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
    const imagePreviews = new Map();

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    function updateCounter() {
      counter.textContent = [...input.value].length + ' chars';
    }
    function rememberSelection() {
      lastSelectionStart = input.selectionStart;
      lastSelectionEnd = input.selectionEnd;
    }
    function notifyDraftChanged() {
      vscode.postMessage({ type: 'draftChanged', text: input.value, terminalId: currentTerminalId });
    }
    function insertAtSelection(text) {
      const start = Math.max(0, Math.min(lastSelectionStart, input.value.length));
      const end = Math.max(start, Math.min(lastSelectionEnd, input.value.length));
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const cursor = start + text.length;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      rememberSelection();
      updateCounter();
      notifyDraftChanged();
    }
    function insertQuotedPath(filePath) {
      insertAtSelection("'" + filePath + "' ");
      scheduleScanForImages();
    }
    function showToast(msg, dur) {
      pasteToast.textContent = msg;
      pasteToast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => pasteToast.classList.remove('show'), dur || 2000);
    }
    function escapeH(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
    function isImageUrl(text) {
      if (!text) return false;
      const t = text.trim();
      if (!t.startsWith('http://') && !t.startsWith('https://')) return false;
      return /\\.(png|jpe?g|gif|webp)(\\?|#|$)/i.test(t);
    }

    // ── Image scanning (looks for 'path.png' patterns) ──
    const IMG_RE = /'([^']+\\.(?:png|jpe?g|gif|webp))'/gi;

    function scanImagePaths() {
      const text = input.value;
      const paths = [];
      const seen = new Set();
      let m;
      IMG_RE.lastIndex = 0;
      while ((m = IMG_RE.exec(text)) !== null) {
        if (!seen.has(m[1])) { seen.add(m[1]); paths.push(m[1]); }
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

    // ── Image strip ──
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
          '<div class="img-card-info"><div class="img-card-name">' + escapeH(info.fileName) + '</div><div class="img-card-path">' + escapeH(p) + '</div></div>' +
          '<button class="img-card-remove" title="Remove">✕</button></div>';
      }).join('');
      imageStrip.classList.add('visible');
      imageStrip.querySelectorAll('.img-card-thumb').forEach(t => {
        t.addEventListener('click', () => {
          const o = document.createElement('div');
          o.className = 'img-expanded-overlay';
          o.innerHTML = '<img src="' + t.src + '" />';
          o.addEventListener('click', () => o.remove());
          document.body.appendChild(o);
        });
      });
      imageStrip.querySelectorAll('.img-card-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('.img-card');
          const p = card.dataset.path;
          // Remove quoted path from textarea
          const esc = p.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
          input.value = input.value.replace(new RegExp("'" + esc + "'\\\\s?", 'g'), '');
          imagePreviews.delete(p);
          updateCounter(); notifyDraftChanged(); scheduleScanForImages();
        });
      });
    }

    // ── Paste handler ──
    input.addEventListener('paste', (e) => {
      const textData = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (isImageUrl(textData.trim())) {
        e.preventDefault();
        showToast('Downloading image…', 5000);
        vscode.postMessage({ type: 'checkClipboardImage', pastedText: textData });
        return;
      }
      if (textData.length === 0) {
        e.preventDefault();
        showToast('Checking clipboard…', 5000);
        vscode.postMessage({ type: 'checkClipboardImage', pastedText: '' });
        return;
      }
      // Normal text — also check for native image
      vscode.postMessage({ type: 'checkClipboardImage', pastedText: textData });
    });

    // ── Event listeners ──
    input.addEventListener('input', () => { rememberSelection(); updateCounter(); notifyDraftChanged(); scheduleScanForImages(); });
    input.addEventListener('click', rememberSelection);
    input.addEventListener('keyup', rememberSelection);
    input.addEventListener('select', rememberSelection);
    input.addEventListener('focus', rememberSelection);
    browseFiles.addEventListener('mousedown', rememberSelection);
    browseFiles.addEventListener('click', () => { rememberSelection(); vscode.postMessage({ type: 'browseFiles' }); });
    togglePreview.addEventListener('click', () => { showPreview = !showPreview; togglePreview.classList.toggle('active', showPreview); scanImagePaths(); });

    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); vscode.postMessage({ type: 'submit', text: input.value }); }
      if (e.key === 'Escape') { e.preventDefault(); vscode.postMessage({ type: 'cancel' }); }
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'terminalSwitched') {
        currentTerminalId = msg.terminalId;
        input.value = msg.content;
        target.textContent = msg.name;
        updateCounter(); input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        rememberSelection(); imagePreviews.clear(); scheduleScanForImages();
      }
      if (msg.type === 'insertFilePaths') {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter(p => typeof p === 'string' && p.length > 0) : [];
        if (paths.length > 0) {
          insertAtSelection(paths.map(p => "'" + p + "'").join(' ') + ' ');
        } else { input.focus(); }
        const previews = msg.imagePreviews || [];
        for (const img of previews) { imagePreviews.set(img.path, { dataUri: img.dataUri, fileName: img.fileName }); }
        if (previews.length > 0) scheduleScanForImages();
      }
      if (msg.type === 'clipboardImageResult') {
        pasteToast.classList.remove('show');
        if (msg.found) {
          insertQuotedPath(msg.path);
          imagePreviews.set(msg.path, { dataUri: msg.dataUri, fileName: msg.fileName });
          scheduleScanForImages();
          showToast('Image pasted ✓', 1500);
        }
      }
      if (msg.type === 'imagePreviewsResolved') {
        for (const img of (msg.images || [])) { imagePreviews.set(img.path, { dataUri: img.dataUri, fileName: img.fileName }); }
        scanImagePaths();
      }
      if (msg.type === 'status') {
        status.textContent = msg.text; status.className = 'active';
        status.style.color = msg.text === 'Done' ? 'var(--vscode-terminal-ansiGreen, #4ec9b0)' : '';
        input.classList.add('disabled'); browseFiles.disabled = true; togglePreview.disabled = true;
      }
      if (msg.type === 'resetStatus') {
        status.className = ''; input.classList.remove('disabled'); browseFiles.disabled = false; togglePreview.disabled = false;
      }
    });
    updateCounter(); scheduleScanForImages();
  </script>
</body>
</html>`;
}

