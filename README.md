# Claude Paste

A VS Code extension that lets you paste large text into **Claude Code** (and other CLI agents) without freezing the terminal.

Works in **VS Code**, **Cursor**, **Windsurf**, and any VS Code-based IDE.

## The Problem

When you paste a large block of text (code, prompts, configs) into Claude Code's terminal, the PTY input buffer overflows and the TUI freezes. The only workaround is to manually paste in small segments — tedious and error-prone.

## How It Works

Claude Paste opens a webview panel where you can freely paste any amount of text. When you submit, the extension:

1. Splits the content into **byte-safe chunks** (under 800 bytes each, respecting UTF-8 boundaries)
2. Wraps all chunks in a **single bracketed paste envelope** with 20ms inter-chunk delays
3. The terminal receives one paste event instead of N, minimizing render cost

## Install

```bash
cd claude-paste-ext
npm install
npm run compile
# Copy to your IDE's local extensions directory:
cp -r . ~/.cursor/extensions/local.claude-paste-1.0.0
# Or for VS Code:
# cp -r . ~/.vscode/extensions/local.claude-paste-1.0.0
```

## Usage

1. Focus on a terminal running Claude Code (or any CLI)
2. Press `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Win/Linux)
3. Paste your content into the panel
4. Press `Cmd+Enter` to insert into the terminal
5. Press Enter in the terminal to submit

### Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+V` / `Ctrl+Shift+V` | Open paste panel |
| `Cmd+Enter` / `Ctrl+Enter` | Insert content into terminal |
| `Esc` | Cancel and close panel |

### Multi-Terminal

Switch between terminals while the panel is open — each terminal keeps its own unsent draft. The panel badge shows which terminal is currently targeted.

## Technical Details

- **PTY Buffer**: macOS PTY input buffer is ~1024 bytes. Each chunk is kept under 800 bytes, ensuring reliable delivery for any text including CJK and emoji.
- **Single Bracketed Paste Envelope**: All chunks share one `\x1b[200~` / `\x1b[201~` pair, reducing React re-renders in TUI apps from N to 1.
- **Per-terminal draft isolation**: Unsent drafts are stored per terminal while the panel is open, cleared on submit or panel close.
- **Terminal following**: Panel title and badge update when switching terminals. Target is resolved at submit time.
- **Focus return**: After inserting, focus returns to the terminal so you can press Enter immediately.

## Known Limitations

- Cannot read terminal input — only content inserted via this extension is tracked.
- To clear inserted content from the terminal, press `Ctrl+C` in Claude Code.

## License

MIT
