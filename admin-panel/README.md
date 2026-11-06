# BNB Sentinel Admin Panel

This folder is a standalone static admin application. It does not import or depend on `frontend/`; its only application integration is the authenticated HTTP API exposed by `backend/`.

## Run

Start the backend using its own instructions, then run the panel from the repository root:

```sh
npm run dev --workspace admin-panel
```

The panel is served by Node.js on port `3002`. Configure its API URL in `admin-panel/.env` for local development:

```dotenv
VITE_API_BASE_URL=http://localhost:4000
```

For a different backend URL or a reverse proxy, update `VITE_API_BASE_URL` in that file. The panel does not derive its API URL from the browser hostname.

## Vercel

This is a standalone static app, separate from `frontend/`. The Vercel build copies the panel files to `dist` and generates `admin-panel-config.js` from `VITE_API_BASE_URL`. The value is read from the app's `.env` for local builds or from the Vercel build environment in production; it is public configuration, not a secret.

To deploy the admin panel in Vercel:

1. Select or create a Vercel project for this repository. If an existing project deploys `frontend/`, use a separate project for the admin panel unless you intend to change what that project serves.
2. In **Project Settings → General**, set **Root Directory** to `admin-panel`.
3. Set the **Framework Preset** to **Other**. The included `vercel.json` sets the build command to `npm run build` and the output directory to `dist`.
4. In **Project Settings → Environment Variables**, add `VITE_API_BASE_URL` with the public HTTPS base URL of the deployed backend (for example, `https://api.example.com`). Use the backend origin, not a URL ending in `/api`, because the panel appends `/api/admin/...` to it. Select **Production** and **Preview** as needed. Do not put credentials or other secrets in this variable.
5. Redeploy after saving the project settings or environment variable. The generated static configuration is set at build time, so changing the variable requires a new deployment.

Sign in with an administrator account configured in the backend environment. The panel uses the existing `/api/admin/*` endpoints for session authentication, monitoring data, wallet deactivation, and manual transfers. Dashboard data refreshes every 15 seconds. The optional “Remember Device” choice stores the admin session token in local storage; otherwise it is limited to the current tab session.

The panel never receives a signing key or database credential. Manual transfer signing, RPC access, and Supabase access remain exclusively in the backend. Use HTTPS and a trusted reverse proxy for production deployments.
