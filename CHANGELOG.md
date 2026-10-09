# Changelog

## [Unreleased]

### Added

- Added `browserjs.frames()` for frame discovery and `browserjs.inFrame()` for targeted iframe DOM automation, including cross-origin frames permitted by Chrome.
- Added live artifact viewer tabs that can move between windows, reuse existing viewers, and load saved files without starting another agent. HTML app updates require an explicit reload.

- Added window-scoped browser working targets: automation selects its tabs within the sidebar's window without focusing that window or accessing tabs in other windows.
- Added automatic and manual conversation compaction, preserving original history, raw tool results, and summary checkpoints across session reloads.
- Added regression coverage for tab targeting, background navigation, compaction, and serialized session checkpoints.

- Added a page research tool for asking focused questions about current-page mechanics without carrying full snapshots in model context.
- Added raw REPL output compaction with a reader tool for searching or slicing omitted output without carrying full dumps in model context.
- Added an estimated current context usage indicator to the sidebar footer.
- Added browser integration tests for Pi runtime, provider payloads, session persistence, research limits, and the pinned web UI.
- Added browser rendering tests for PDF/DOCX/XLSX attachments, Markdown and math, diffs, icons, and both Three.js animations.

### Changed

- Simplified browser script execution and frame handling; removed unused execution bookkeeping, wrapper options, and compatibility paths.
- New artifacts no longer automatically cover the conversation. The artifact list and tool results offer Open in tab; sidebar previews remain available on demand.
- Separated artifact rendering, snapshot-only HTML access, live connections, and reading-position restoration; consolidated file errors and replayed saved artifacts in a single pass.
- Consolidated working-window validation and tab selection; navigation results stay bound to the tab that was navigated.
- Upgraded the pi runtime packages and bundled model catalog to 1.0.4 while retaining pi-web-ui 0.75.3 through pi-ai's compatibility entry point.
- Replaced removed Pi compaction helpers with local context estimation, tool-safe history boundaries, and browser-focused summaries through the existing chat transport.
- Simplified compaction text formatting, usage estimation, and summary requests; removed redundant snapshot copying and the generic provider-error fallback.
- Migrated page research to transcript-based system prompts and Pi's completed-turn hook.
- Session persistence now saves message boundaries and coalesced streaming checkpoints with serialized writes, including the initial user message and interrupted response text.
- Simplified browser target handling, navigation results, compaction preparation, and persistence snapshots; removed unused overlay helpers and consolidated REPL cleanup.
- Moved persistence, cost accounting, and compaction lifecycle into a session-scoped owner; separated pure compaction preparation from provider requests.
- Simplified background browser tests with scoped tab ownership, session-bound page commands, and standard event waiting.
- Scoped skill disclosure tracking to each session, simplified navigation skill results, and recorded completed-message costs directly from their own provider/model metadata.
- Simplified skill text assembly and normalized CDP errors at the protocol boundary so request cleanup handles a single error shape.
- Navigation now rejects conflicting actions and distinguishes tab-list results from navigation results; browser target selection is private and protected against stale asynchronous reads.
- Browser screenshots and element picking validate their target instead of silently using a different visible tab; navigation reports closed tabs, errors, and timeouts.
- Refreshed compatible extension and website dependencies to address known dependency vulnerabilities.
- Synchronized linked mini-lit dependency metadata after its Claude Code and Vitest security updates.
- Added a Devbox environment with Node.js 24 for dependency management and checks.
- Updated esbuild to 0.28.2, concurrently to 10.0.5, and Chrome API types to 0.3.1.
- Updated document rendering, icons, Three.js, TypeScript 7, and website Vite 8. Kept the pinned web UI on the same document-rendering versions as the extension.
- Updated extension and website linting to Biome 2.5.14. Disabled website accessibility lint rules while retaining other recommended checks.

### Fixed

- Currency amounts in Markdown no longer render intervening prose as italicized math with missing spaces.
- Sandboxed artifact links now open only HTTP(S) websites, preventing generated HTML from opening privileged extension pages or executable URL schemes.
- Session artifact reconstruction ignores textual command failures, and navigation rejects artifact viewer destinations before changing browser tabs.
- Live spreadsheet updates retain the selected worksheet and reading position.
- Refresh the message editor after the agent actually becomes idle, so slow final saves cannot leave the Stop button visible or block new messages.
- Serialized session lock acquisition and release across sidebars, retained the initial port connection, and matched concurrent replies by request ID. Locks remain held until the last connection in their window closes.
- Browser integration test runner now closes lingering HTTP connections and waits for server shutdown instead of hanging after reporting results.
- Browser test CDP requests now clear pending timers on failure and stop waiting immediately when Chrome disconnects.
- Browser integration tests now request a background tab and emulate page focus for rendering instead of activating the test tab.
- Markdown and other file attachments now reach the model in Sitegeist's custom message transformer.
- Live chat rendering now updates after message events that mutate the message array in place.
- Sidebar no longer remains visually stuck in streaming mode after `agent_end` fires before the agent clears runtime state.
- System instructions and tool declarations survive the pinned web UI's message conversion.
- Page research retains its collected evidence for the final answer and includes the full transcript in tool details.
- Adapted the pinned web UI's PDF cleanup calls to PDF.js 6's loading-task API.

### Removed

- Removed Google Gemini CLI subscription OAuth. Google Gemini remains available through API-key authentication.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
