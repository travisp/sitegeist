<p align="center">
  <img src="media/hero.png" alt="Sitegeist" width="400">
</p>

An AI assistant that lives in your browser sidebar. Built for collaboration, not autonomy theater. You guide, it executes.

Sitegeist can automate repetitive web tasks, extract data from any website, navigate across pages, fill out forms, compare products, compile research, and transform what it finds into documents, spreadsheets, or whatever you need. It works on any website through a Chrome/Edge side panel, using the AI provider of your choice.

Bring your own API key or log in with an existing subscription (Anthropic Claude, OpenAI/ChatGPT, GitHub Copilot, Google Gemini). Your data stays on your machine. Nothing is collected or tracked.

## Download & Install

Visit [sitegeist.ai](https://sitegeist.ai) for download links and step-by-step installation instructions.

Requires Chrome 141+ or Edge equivalent.

## Development

Clone this repo plus its sibling dependencies into the same parent directory:

```
parent/
  mini-lit/          # https://github.com/badlogic/mini-lit
  pi-mono/           # https://github.com/badlogic/pi-mono
  sitegeist/         # this repo
```

Install dependencies in each repo:

```bash
(cd ../mini-lit && npm install)
(cd ../pi-mono && npm install)
npm install
```

`npm install` sets up the Husky pre-commit hook automatically.

Start all dev watchers (mini-lit, pi-mono, sitegeist extension, marketing site):

```bash
./dev.sh
```

Changes in `../mini-lit` or `../pi-mono` are rebuilt automatically and picked up by the sitegeist watcher.

To run only the extension watcher without dependencies or the marketing site:

```bash
npm run dev
```

### Loading the extension

1. Open `chrome://extensions/` or `edge://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select `sitegeist/dist-chrome/`
5. Click "Details" on the Sitegeist extension and enable:
   - **Allow user scripts**
   - **Allow access to file URLs**

The extension hot-reloads when the dev watcher rebuilds.

### First run

On first launch, Sitegeist prompts you to connect at least one AI provider. You can log in with a subscription or enter an API key.

Some subscription logins require the CORS proxy (configurable in Settings > Proxy). The default proxy is `https://proxy.mariozechner.at/proxy`.

## Browser targets and long conversations

Each sidebar works only in its own window. Tasks start on that window's selected tab; opening or selecting a working tab makes it visible within that window without bringing the window to the foreground. Tab listings and target selection are limited to this window, so you can browse in other windows undisturbed. This also applies to the REPL's `navigate()` helper. Click the working-tab button in the sidebar to explicitly bring the window forward. Moving the target to another window stops access to it until you select a tab in the working window.

Screenshots require the target to be the selected tab in its window, but that window can be unfocused. The element picker requires a focused, selected target. Neither silently captures or interacts with another tab. Background websites can still throttle execution or require focus, and closing the sidebar does not keep an agent running.

Long conversations compact automatically before model requests, including between tool turns. **Compact** in the footer triggers this manually; Escape cancels summarization. Sitegeist retains recent messages without splitting tool-call/result batches and generates a browser-focused summary using the current model and existing credentials. The default budgets reserve 16,384 tokens and retain about 20,000 recent tokens, capped at a quarter of the model's context window for smaller models.

Compaction keeps the original conversation, artifacts, and raw outputs in session storage and exports. Only the context sent to the model becomes a summary plus recent messages. The existing REPL output previews and raw-output reader are unchanged. Summaries appear as expandable conversation entries, and their usage is included in session costs. Failed or cancelled summarization leaves the conversation intact. This is proactive compaction, not automatic recovery from every provider context-overflow error.

Sessions save after completed messages and at most once per two seconds during continuous streaming. Partial responses are restored as interrupted text, without unfinished tool calls.

## Checks

```bash
./check.sh
```

Runs formatting, linting, and type checking for the extension and the `site/` subproject.

The Husky pre-commit hook runs the same checks before each commit.

### Session lock tests

```bash
devbox run -- npm run test:session-locks
```

Tests simultaneous session access, connection ownership, startup restoration, request correlation, and reconnect cleanup without a browser. These tests also run in the browser integration suite.

### Pi runtime and rendering integration tests

With Chrome running with remote debugging enabled on port 9222:

```bash
devbox run -- npm run test:pi-runtime
```

Set `CHROME_DEBUG_URL` to use another debugging endpoint. The tests open and close an isolated background tab without requesting browser activation. DevTools focus emulation keeps rendering tests running without selecting the tab. They bundle the extension in memory using its production build options, and exercise Pi with the pinned web UI. Model responses and provider HTTP requests are mocked; no credentials or live API calls are used. The tests also cover PDF/DOCX/XLSX extraction, document previews, Markdown/math, diffs, icons, and both Three.js animations using generated fixtures. The tests do not write to `dist-chrome/` or reload the extension.

## Building

```bash
npm run build
```

The unpacked extension is written to `dist-chrome/`.

## Updating the website

```bash
cd site && ./run.sh deploy
```

Builds the static site and uploads it to `sitegeist.ai`. Requires SSH access to `slayer.marioslab.io`.

## Releasing

```bash
./release.sh patch   # 1.0.0 -> 1.0.1
./release.sh minor   # 1.0.0 -> 1.1.0
./release.sh major   # 1.0.0 -> 2.0.0
```

Bumps the version in `static/manifest.chrome.json`, commits, tags, and pushes. GitHub Actions builds the extension and creates a release at [github.com/badlogic/sitegeist/releases](https://github.com/badlogic/sitegeist/releases).

## License

AGPL-3.0. See [LICENSE](LICENSE).
