# CELESTIAL + SINZU TOOLS (Render)

Isang Render web service: Sinzu Tools site sa `/` at CELESTIAL bot dashboard sa `/celestial`.
Lahat ng files nasa root (walang folders).

## Deploy sa Render
1. I-upload ang lahat ng files na ito sa (private) GitHub repo.
2. Render > New > Web Service > piliin ang repo.
   - Runtime **Docker** = kumpleto (bot + inbox + media downloader).
   - Runtime **Node** (build `npm install`, start `npm start`) = bot + inbox lang; hindi gagana ang downloader.
3. Environment variables:
   - `ECLIPSE_DASHBOARD_API_KEY` – dashboard password (palitan mo ang default sa bot.js).
   - `BANAT_ALLOWED_USERS` – hanggang **2** Facebook user ID na pwedeng gumamit ng `!banat on/off/...`
     (kapag walang laman = lahat pwede).
   - `BANAT_RESTRICT_REPLIES=true` – kung gusto mong sila lang ang sasagutin ng bot.
4. Buksan `https://<your-app>.onrender.com/celestial`, ilagay ang password, i-paste ang cookie, **Save & connect**.
5. Sa Messenger GC: `!banat on`.

## Bilis ng reply (env, optional)
| Var | Default | Ibig sabihin |
|---|---|---|
| `BANAT_REPLY_DELAY_MS` | 150 | pause bago lumabas ang typing |
| `BANAT_SPEED_FACTOR` | 0.3 | 1 = dating bagal |
| `BANAT_MIN_TYPING_MS` / `BANAT_MAX_TYPING_MS` | 500 / 1800 | tagal ng typing indicator |
| `BANAT_THREAD_COOLDOWN_MS` | 800 | pagitan ng sends sa iisang thread (dati 12000) |

## Cookie persistence
Ang Render free disk ay nabubura kada redeploy. Gumamit ng Render Disk at i-set
`CELESTIAL_SESSION_FILE=/data/appstate.json`, o i-set ang `FB_APPSTATE` env var.
Free plan: may self-ping (`RENDER_EXTERNAL_URL`) para hindi matulog ang bot.
