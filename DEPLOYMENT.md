# Deployment checklist (Vercel + Render)

## Fix 404 / MIME / WebSocket errors

1. **Redeploy the frontend** (Vercel and/or Render) so the latest `public/` is served.  
   The repo now:
   - Loads Vercel Insights only when the site is on `vercel.app` (not on `onrender.com`), so you won’t get 404 or “Refused to execute script” on Render.
   - Uses an inline logo (no `logo.png` file), so no logo 404.

2. **Backend (Render – signaling server)**  
   In the service that runs `node server/server.js` (e.g. `anonkonnect-server`):
   - Set **Environment** → `FRONTEND_URL` to your frontend URL(s), comma‑separated if you use both:
     - `https://your-app.vercel.app,https://anonkonnect.onrender.com`
   - Redeploy the backend after changing env.

3. **`database.js` / `index.js` error**  
   The error “The requested module './database.js' does not provide an export named 'default'” does **not** come from this repo (there is no `database.js` here).  
   Fix it in the project that has `index.js` importing `./database.js`: either add a default export in `database.js` or change the import to use the named export that file actually exports.  
   Often this is in a Vercel serverless API (e.g. `/api`) or another app.

4. **WebSocket**  
   After redeploying frontend and backend and setting `FRONTEND_URL`, the client should connect. If the backend was sleeping (Render free tier), the first load can take up to ~50 seconds.
