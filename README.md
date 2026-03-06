# YouTrack KB Assistant (MVP)

YouTrack app for `DASHBOARD_WIDGET` that:
- searches Knowledge Base articles live via YouTrack REST,
- sends only accessible article excerpts to a local LiteLLM endpoint (`/chat/completions`),
- returns an answer with source links to the related articles,
- renders the answer with streaming-like progressive output in the widget UI.

## Scope
- MVP only supports questions about Knowledge Base articles.
- No chat history is stored.
- German and English UI/answer language support.

## Files
- `manifest.json`
- `settings.json`
- `backend.js`
- `widgets/kb-assistant/index.html`
- `widgets/kb-assistant/widget.js`
- `widgets/kb-assistant/styles.css`
- `widgets/kb-assistant/icon.svg`

## Configure app settings
In YouTrack App settings:
- `LiteLLM Base URL`: `http://<LITELLM_HOST>:4000/v1` (replace placeholder)
- `LiteLLM Model`: model id exposed by LiteLLM
- `LiteLLM API Key`: secret bearer token
- `Max Articles`: optional (current widget uses 6 in MVP)

## Install on YouTrack 2025.3 (self-hosted)
1. Zip the app files from the repository root.
2. In YouTrack: `Administration -> Apps -> Upload app package`.
3. Open app settings and fill required LiteLLM values.
4. Add the widget to a dashboard.

## Notes
- Access control is preserved by searching articles through `fetchYouTrack` under the current user context.
- The widget uses UI-side progressive rendering for streaming-like output. If true token streaming (SSE passthrough) is required, add a dedicated streaming endpoint and client transport compatible with YouTrack app host constraints.
- Logging is expected to be handled by LiteLLM, as requested.
