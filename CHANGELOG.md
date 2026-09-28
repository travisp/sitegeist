# Changelog

## [Unreleased]

### Added

- Added a page research tool for asking focused questions about current-page mechanics without carrying full snapshots in model context.
- Added raw REPL output compaction with a reader tool for searching or slicing omitted output without carrying full dumps in model context.
- Added an estimated current context usage indicator to the sidebar footer.
- Added browser integration tests for Pi runtime, provider payloads, session persistence, research limits, and the pinned web UI.
- Added browser rendering tests for PDF/DOCX/XLSX attachments, Markdown and math, diffs, icons, and both Three.js animations.

### Changed

- Upgraded the pi runtime packages to 0.87.1 while retaining pi-web-ui 0.75.3 through pi-ai's compatibility entry point.
- Migrated page research to transcript-based system prompts and Pi's completed-turn hook.
- Refreshed compatible extension and website dependencies to address known dependency vulnerabilities.
- Synchronized linked mini-lit dependency metadata after its Claude Code and Vitest security updates.
- Added a Devbox environment with Node.js 24 for dependency management and checks.
- Updated esbuild to 0.28.2, concurrently to 10.0.5, and Chrome API types to 0.3.1.
- Updated document rendering, icons, Three.js, TypeScript 7, and website Vite 8. Kept the pinned web UI on the same document-rendering versions as the extension.
- Updated extension and website linting to Biome 2.5.14. Disabled website accessibility lint rules while retaining other recommended checks.

### Fixed

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
