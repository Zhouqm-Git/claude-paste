import * as vscode from "vscode";

// macOS PTY input buffer is ~1024 bytes; keep each UTF-8 chunk well under this limit
const MAX_CHUNK = 800;
const CHUNK_DELAY = 20;

let activePanel: vscode.WebviewPanel | null = null;
const terminalIds = new WeakMap<vscode.Terminal, string>();
let nextTerminalId = 1;

class OperationCancelled extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "OperationCancelled";
  }
}

type CancellationCheck = () => boolean;

function throwIfCancelled(isCancelled: CancellationCheck) {
  if (isCancelled()) {
    throw new OperationCancelled();
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-paste.openPanel", () => {
      openPastePanel();
    })
  );
}

function chunkText(text: string, maxBytes: number): string[] {
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

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function openPastePanel() {
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

  // Per-terminal drafts (panel-scoped, discarded on panel close)
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

    // --- DRAFT CHANGED (user typed in textarea) ---
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

      if (!selected || selected.length === 0) {
        return;
      }

      panel.webview.postMessage({
        type: "insertFilePaths",
        paths: selected.map((uri) => uri.fsPath),
      });
      return;
    }

    // --- SUBMIT ---
    if (msg.type === "submit") {
      const text = normalizeText(msg.text || "");

      // Resolve target at submit time, not panel-open time
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

      // Show submitting status in webview
      panel.webview.postMessage({ type: "status", text: "Inserting..." });

      // Empty text = close without sending anything.
      if (text.length === 0) {
        drafts.delete(term);
        term.show();
        panel.dispose();
        return;
      }

      // Send content
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

      // Clear draft for submitted terminal
      drafts.delete(term);

      // Return focus to terminal so user can press Enter immediately
      term.show();

      // Show done status briefly before closing
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

/**
 * Send text using a single bracketed paste envelope with chunked transport.
 * The application receives one paste event instead of N, reducing render cost.
 */
async function sendChunked(
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

function getWebviewHtml(initialContent: string, terminalName: string, terminalId: string): string {
  const escaped = escapeHtml(initialContent);
  const charCount = [...initialContent].length;

  return `<!DOCTYPE html>
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
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 12px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
  }
  .header h2 { font-size: 14px; font-weight: 600; opacity: 0.9; }
  .target {
    font-size: 12px;
    opacity: 0.6;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px;
    border-radius: 10px;
  }
  #status {
    display: none;
    text-align: center;
    padding: 8px;
    font-size: 13px;
    opacity: 0.8;
  }
  #status.active { display: block; }
  #input {
    flex: 1;
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.6;
    resize: none;
    outline: none;
  }
  #input:focus { border-color: var(--vscode-focusBorder); }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #input.disabled { opacity: 0.5; pointer-events: none; }
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 8px;
    margin-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .footer-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .footer .keys { font-size: 12px; opacity: 0.5; }
  .footer .keys kbd {
    background: var(--vscode-keybindingLabel-background);
    border: 1px solid var(--vscode-keybindingLabel-border);
    border-radius: 3px;
    padding: 1px 5px;
    font-family: inherit;
    font-size: 11px;
  }
  button {
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    padding: 4px 10px;
    font-family: inherit;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  #char-count { font-size: 12px; opacity: 0.5; }
</style>
</head>
<body>
  <div class="header">
    <h2>Claude Paste</h2>
    <span class="target" id="target">${escapeHtml(terminalName)}</span>
  </div>
  <div id="status"></div>
  <textarea id="input" placeholder="Paste your content here..." autofocus>${escaped}</textarea>
  <div class="footer">
    <div class="footer-left">
      <button id="browse-files" class="secondary" type="button" title="Insert file or folder paths at cursor">Browse Files...</button>
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
    const browseFiles = document.getElementById('browse-files');
    let currentTerminalId = ${JSON.stringify(terminalId)};
    let lastSelectionStart = input.value.length;
    let lastSelectionEnd = input.value.length;

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

    input.addEventListener('input', () => {
      rememberSelection();
      updateCounter();
      notifyDraftChanged();
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
      }
      if (msg.type === 'insertFilePaths') {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter((p) => typeof p === 'string' && p.length > 0) : [];
        if (paths.length > 0) {
          insertAtSelection(paths.join(' '));
        } else {
          input.focus();
        }
      }
      if (msg.type === 'status') {
        status.textContent = msg.text;
        status.className = 'active';
        if (msg.text === 'Done') {
          status.style.color = 'var(--vscode-terminal-ansiGreen, #4ec9b0)';
        } else {
          status.style.color = '';
        }
        input.classList.add('disabled');
        browseFiles.disabled = true;
      }
      if (msg.type === 'resetStatus') {
        status.className = '';
        input.classList.remove('disabled');
        browseFiles.disabled = false;
      }
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
  </script>
</body>
</html>`;
}
