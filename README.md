# Claude Paste

A VS Code extension that lets you paste large text and images into **Claude Code** (and other CLI agents) without freezing the terminal.

Works in **VS Code**, **Cursor**, **Windsurf**, and any VS Code-based IDE.

## The Problem

When you paste a large block of text (code, prompts, configs) into Claude Code's terminal, the PTY input buffer overflows and the TUI freezes. The only workaround is to manually paste in small segments — tedious and error-prone.

## Features

- **Paste large text** without freezing — content is split into byte-safe chunks with bracketed paste
- **Paste screenshots** — clipboard images are auto-detected and saved locally
- **Paste image URLs** — URLs pointing to images are automatically downloaded and inserted as local file paths
- **Browse Files** — insert file/folder paths via a file picker
- **Image preview strip** — thumbnail previews of detected image paths with click-to-enlarge
- **Multi-terminal drafts** — each terminal keeps its own unsent content

## How It Works

Claude Paste opens a webview panel where you can freely paste any content. When you submit:

1. Text is split into **byte-safe chunks** (under 800 bytes each, respecting UTF-8 boundaries)
2. All chunks are wrapped in a **single bracketed paste envelope** with 20ms inter-chunk delays
3. Image file paths are inserted as plain text — Claude Code auto-detects images by file extension

### Image Support

- **Screenshots**: Copy a screenshot (Cmd+Shift+4, etc.), then paste normally — the image is saved to `.claude-paste-images/` in your workspace and the path is inserted
- **Image URLs**: Paste an image URL — it's downloaded, saved locally, and the URL is replaced with the local path
- **File picker**: Click "Browse Files..." to select image files or any other files

Supported formats: PNG, JPEG, GIF, WebP.

## Install

```bash
cd claude-paste-ext-v2
npm install
npm run compile
# Copy to your IDE's local extensions directory:
cp -r . ~/.cursor/extensions/local.claude-paste-2.0.0
# Or for VS Code:
# cp -r . ~/.vscode/extensions/local.claude-paste-2.0.0
```

## Usage

1. Focus on a terminal running Claude Code (or any CLI)
2. Press `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Win/Linux)
3. Paste your content or images into the panel
4. Press `Cmd+Enter` to insert into the terminal
5. Press Enter in the terminal to submit

### Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+V` / `Ctrl+Shift+V` | Open paste panel |
| `Cmd+Enter` / `Ctrl+Enter` | Insert content into terminal |
| `Esc` | Cancel and close panel |

## Technical Details

- **PTY Buffer**: macOS PTY input buffer is ~1024 bytes. Each chunk is kept under 800 bytes, ensuring reliable delivery for any text including CJK and emoji.
- **Single Bracketed Paste Envelope**: All chunks share one `\x1b[200~` / `\x1b[201~` pair, reducing React re-renders in TUI apps from N to 1.
- **Per-terminal draft isolation**: Unsent drafts are stored per terminal while the panel is open, cleared on submit or panel close.
- **Async clipboard detection**: Platform-native tools (pngpaste/osascript on macOS, xclip on Linux, PowerShell on Windows) are used asynchronously to detect clipboard images.
- **Content Security Policy**: Webview uses CSP with nonce-based script/style allowlisting.
- **Focus return**: After inserting, focus returns to the terminal so you can press Enter immediately.

## Known Limitations

- Cannot read terminal input — only content inserted via this extension is tracked.
- To clear inserted content from the terminal, press `Ctrl+C` in Claude Code.
- File drag-and-drop is not supported — VS Code intercepts drops on webview panels. Use "Browse Files..." instead.
- Image clipboard detection requires platform tools (pngpaste or macOS built-in osascript on Mac, xclip on Linux, PowerShell on Windows).

## License

MIT
