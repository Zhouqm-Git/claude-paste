# Claude Paste

A VS Code extension that lets you paste **large text and images** into Claude Code's terminal — without freezing.

Works in **VS Code**, **Cursor**, **Windsurf**, and any VS Code-based IDE.

https://github.com/user-attachments/assets/placeholder.mp4

> **Demo**: Pasting a large code file and a screenshot into Claude Code via Claude Paste.

---

## Why?

When you paste a large block of text into Claude Code's terminal, the PTY input buffer overflows and the TUI **freezes**. The only workaround is to manually paste in tiny segments — tedious and error-prone.

Claude Paste solves this by splitting your content into byte-safe chunks and sending them with bracketed paste protocol, keeping the terminal responsive.

---

## Features

- **Large text paste** — split into safe chunks, no freezing
- **Screenshot paste** — auto-detect clipboard images, save locally
- **Image URL paste** — auto-download and insert as local path
- **Image preview strip** — thumbnails with click-to-enlarge
- **Browse Files** — pick files/folders via native dialog
- **Multi-terminal drafts** — each terminal keeps its own content
- **Focus return** — jump straight back to terminal after insert

---

## Install

```bash
git clone https://github.com/Zhouqm-Git/claude-paste.git
cd claude-paste
npm install
npm run compile

# For Cursor:
cp -r . ~/.cursor/extensions/local.claude-paste-2.0.0

# For VS Code:
# cp -r . ~/.vscode/extensions/local.claude-paste-2.0.0
```

Then reload your IDE (`Cmd+Shift+P` → `Developer: Reload Window`).

---

## Usage

1. Focus on a terminal running Claude Code
2. Press `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Win/Linux)
3. Paste your content into the panel
4. Press `Cmd+Enter` to insert into the terminal
5. Press `Enter` in the terminal to submit to Claude

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+V` | Open paste panel |
| `Cmd+Enter` | Insert into terminal |
| `Esc` | Cancel and close |

### Image Support

| Method | How |
|--------|-----|
| Screenshot | Copy a screenshot, then `Cmd+V` in the panel |
| Image URL | Paste any `https://*.png/jpg/gif/webp` URL |
| File picker | Click "Browse Files..." button |

Supported formats: **PNG, JPEG, GIF, WebP**.

Images are saved to `.claude-paste-images/` in your workspace (auto-ignored by git).

---

## How It Works

1. Content is split into **byte-safe chunks** (< 800 bytes each, UTF-8 boundary aware)
2. All chunks are wrapped in a **single bracketed paste envelope** (`\x1b[200~` ... `\x1b[201~`) with 20ms inter-chunk delays
3. Image paths are inserted as plain text — Claude Code auto-detects images by file extension

---

## Known Limitations

- Cannot read existing terminal input — only content inserted via this extension is tracked
- File drag-and-drop is not supported (VS Code intercepts drops on webview panels). Use "Browse Files..." instead
- Image clipboard detection on macOS requires either `pngpaste` (`brew install pngpaste`) or the built-in `osascript`

---

## License

[MIT](LICENSE)
