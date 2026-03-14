# Deployment checklist (Vercel + Render)

## Fix backend 404/CORS: Render dashboard steps (do this first)

The backend at **anonkonnect-server.onrender.com** must be a **Web Service** that runs the Node server. If you get 404 + CORS on `/socket.io/`, that service is not running Node.

**Option A – Change the existing "anonkonnect-server" service**

1. Go to [dashboard.render.com](https://dashboard.render.com) and open the service whose URL is **anonkonnect-server.onrender.com**.
2. Go to **Settings** (left sidebar).
3. Check **Service Type**. If it says **Static Site**, you cannot convert it; use Option B.
4. If it is **Web Service**, set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Root Directory:** leave **empty**
5. Click **Save Changes**, then **Manual Deploy** → **Deploy latest commit**.
6. Wait for the deploy to finish (Logs should show "AnonKonnect Server running on port ...").
7. Open **https://anonkonnect-server.onrender.com/health** — you should see `{"status":"ok",...}`.

**Option B – Create a new Web Service (if the current one is Static Site)**

1. In Render dashboard, click **New +** → **Web Service**.
2. Connect your **anonkonnect** repo (same as the frontend).
3. Use:
   - **Name:** `anonkonnect-server` (or any name; you’ll use the new URL in the frontend).
   - **Region:** your choice.
   - **Branch:** `main` (or your default).
   - **Runtime:** **Node**.
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Root Directory:** leave **empty**.
4. Under **Environment**, add **FRONTEND_URL** = `https://anonkonnect.onrender.com` (or leave it unset to allow all origins).
5. Click **Create Web Service** and wait for the first deploy.
6. Copy the service URL (e.g. `https://anonkonnect-server.onrender.com` or a new one).
7. If the URL is different from before, update the frontend: in `public/app.js` set the signaling URL to the new backend URL (search for `anonkonnect-server.onrender.com` and replace with your new URL), then redeploy the frontend.

After the backend is a Web Service and deploy succeeds, **https://anonkonnect-server.onrender.com/health** must return JSON. Then `/socket.io/` will work and CORS will be handled by the server.

---

## Backend returns 404 for /socket.io/ (and CORS error)

If you see **404 (Not Found)** on `https://anonkonnect-server.onrender.com/socket.io/` and "No 'Access-Control-Allow-Origin' header", the backend URL is **not** running this Node.js app. The request never reaches Socket.IO, so you get a 404 (and no CORS headers).

**Do this:**

1. **Check the backend**  
   Open **https://anonkonnect-server.onrender.com/health** in the browser.
   - If you get **`{"status":"ok",...}`** → the Node app is running; then CORS/env is the issue (see below).
   - If you get **404 or a static page** → the service is not running the Node server. Fix the Render service:

2. **Render backend must be a Web Service (not Static Site)**  
   - In Render dashboard, the **anonkonnect-server** service must be type **Web Service**.
   - **Build Command:** `npm install` (or leave default).
   - **Start Command:** `npm start` or `node server/server.js`.
   - **Root Directory:** leave empty (or `.`) so the repo root with `package.json` and `server/` is used.
   - Redeploy after changing these.
   - **Optional:** The repo has a **`render.yaml`** (Blueprint). When creating a new Web Service, connect this repo and Render can use it to set build/start and health check; set `FRONTEND_URL` in the Dashboard.

3. **If you use one repo for frontend and backend**  
   - You should have **two** Render services: one **Static Site** (or Vercel) for the frontend (anonkonnect.onrender.com), and one **Web Service** for the backend (anonkonnect-server.onrender.com).
   - The **backend** service must use the same repo but run the Node server (start command above). Do not deploy the backend as a static site.
   - If you currently have two "Static Site" services, delete the backend one and create a new **Web Service** pointing at this repo, with Start Command `npm start`.

4. **After the Node app is running**  
   - Set **Environment** → `FRONTEND_URL` to `https://anonkonnect.onrender.com` (no trailing slash), or leave unset to allow all origins.
   - Redeploy the backend.

---

## Fix 404 / MIME / WebSocket errors (frontend)

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
