# BNB Sentinel Admin Panel

This folder is a standalone static admin application. It does not import or depend on `frontend/`; its only application integration is the authenticated HTTP API exposed by `backend/`.

## Run

Start the backend using its own instructions, then run the panel from the repository root:

```sh
npm run dev --workspace admin-panel
```

The panel is served on port `3002` and expects the backend API on port `4000` at the same hostname. When the API is exposed at a different URL or through a reverse proxy, define `window.__ADMIN_PANEL_API_URL__` before `admin.js` loads, for example:

```html
<script>window.__ADMIN_PANEL_API_URL__ = "https://admin-api.example.com";</script>
```

Sign in with an administrator account configured in the backend environment. The panel uses the existing `/api/admin/*` endpoints for session authentication, monitoring data, wallet deactivation, and manual transfers. Dashboard data refreshes every 15 seconds. The optional “Remember Device” choice stores the admin session token in local storage; otherwise it is limited to the current tab session.

The panel never receives a signing key or database credential. Manual transfer signing, RPC access, and Supabase access remain exclusively in the backend. Use HTTPS and a trusted reverse proxy for production deployments.
