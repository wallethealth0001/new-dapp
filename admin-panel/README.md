# BNB Sentinel Admin Panel

This folder is a standalone static admin application. It does not import or depend on `frontend/`; its only application integration is the authenticated HTTP API exposed by `backend/`.

## Run

Start the backend using its own instructions, then run the panel from the repository root:

```sh
npm run dev --workspace admin-panel
```

The panel is served by Node.js on port `3002`. Configure its API URL in `admin-panel/.env`:

```dotenv
VITE_API_BASE_URL=http://localhost:4000
```

For a different backend URL or a reverse proxy, update `VITE_API_BASE_URL` in that file. The panel reads this setting from its own `.env`; it does not derive the API URL from the browser hostname.

Sign in with an administrator account configured in the backend environment. The panel uses the existing `/api/admin/*` endpoints for session authentication, monitoring data, wallet deactivation, and manual transfers. Dashboard data refreshes every 15 seconds. The optional “Remember Device” choice stores the admin session token in local storage; otherwise it is limited to the current tab session.

The panel never receives a signing key or database credential. Manual transfer signing, RPC access, and Supabase access remain exclusively in the backend. Use HTTPS and a trusted reverse proxy for production deployments.
