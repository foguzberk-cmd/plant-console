# Plant Console — deploy to Render

A single static HTML page. No build step, no server. `index.html` is the whole app.

## Option A — quickest (no config file needed)
1. Put this folder in a GitHub/GitLab repo and push it.
2. In Render: **New + → Static Site** → pick the repo.
3. Settings:
   - **Build Command:** leave empty
   - **Publish Directory:** `.`  (the repo root, where `index.html` lives)
4. **Create Static Site.** Render gives you a live `*.onrender.com` URL.

## Option B — one-click with the included blueprint
`render.yaml` is already set up. In Render: **New + → Blueprint** → pick the repo → **Apply**.

## Notes
- If your Render account shows `env: static` instead of `runtime: static` in the blueprint, swap that one line.
- Every push to the connected branch auto-redeploys.
- Because it's plain static, the same folder also works on Netlify, Vercel, Cloudflare Pages, or GitHub Pages — just point the host at this folder and serve `index.html`.
