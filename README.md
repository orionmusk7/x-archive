# X Thread Saver

Personal archive for an X post and the replies returned by X's web conversation endpoint. The project keeps the original local Python application and adds a separately deployed Cloudflare Worker edition.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/orionmusk7/x-archive)

The button clones this public repository into your GitHub account, provisions the supported Cloudflare resources, and deploys the Worker. You need a Cloudflare account and a GitHub account. During setup, choose a unique Worker/repository name and supply a strong `APP_PASSWORD` plus a `SESSION_ENCRYPTION_KEY`. Generate the latter as 32 random bytes encoded in Base64 (for example, `openssl rand -base64 32`). Store it in a password manager and do not rotate it while you need to read the X cookie already encrypted in D1. Cloudflare will provision the Workers, D1, R2, and Queues resources declared in the Wrangler configuration.

After deployment, open the assigned `*.workers.dev` URL, log in with the `APP_PASSWORD`, then open **登录态设置** and save your own X Cookie containing `auth_token` and `ct0`. The X Cookie is encrypted using `SESSION_ENCRYPTION_KEY` before it is stored in D1. Do not use or share anyone else's Cookie. The app's login session lasts 30 days and refreshes while in use.

## Cloudflare deployment

The Cloudflare Worker edition uses:

- **R2 Standard** for private images, video files, and posters; files are streamed, not exposed through a public R2 domain. Cloudflare's current R2 Free allowance is 10 GB-month of Standard storage, 1 million Class A operations, 10 million Class B operations, and free internet egress. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- **D1** for archive metadata, comment trees, encrypted X cookies, password-session hashes, and login throttling.
- **Queues** for incremental reply pagination so one long thread does not run in a single request.
- **Workers Static Assets** for the login and archive UI.

### Authentication and secrets

- Access is protected by an app password held only as a Worker secret. Login is rate-limited to 8 failures per client IP per 15 minutes.
- The opaque login cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`, expires after 30 days, and is slid forward during use. Its opaque server-side token is stored only as a SHA-256 hash; it is revoked on logout.
- The X cookie (`auth_token`, `ct0`) is AES-GCM encrypted with a separate Worker secret before being written to D1. It remains saved until replaced/cleared or until X invalidates it; the app does not require re-entry on Worker restarts.
- Never store either secret in source control. To rotate the access password, run `npx wrangler secret put APP_PASSWORD`. Keep `SESSION_ENCRYPTION_KEY` unchanged if you need to continue decrypting the stored X cookie; rotating it requires re-entering that cookie.
- The Worker validates same-origin writes, limits login attempts, escapes user/API text, applies a restrictive CSP, requires authentication for archive/API/media/export access, and serves R2 videos with authenticated byte-range responses.

### Manual deployment and maintenance

From this directory, after connecting Wrangler to the Cloudflare account where you want the app deployed:

```sh
npm install
npm test
npm run build
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_ENCRYPTION_KEY
npm run deploy
```

Bindings and generic resource names are declared in `wrangler.jsonc`; they do not refer to any maintainer's Cloudflare account or custom domain. D1 changes belong in `migrations/`. `npm run deploy` applies D1 migrations to the database bound as `DB` before deploying. Both secrets are required for the Worker to accept logins and encrypt X cookies. The Deploy to Cloudflare flow prompts you for these values. Keep `SESSION_ENCRYPTION_KEY` backed up: losing or changing it means saved X cookies must be entered again.

Configure a custom domain later in your own Worker settings if desired. Never put either secret, an X Cookie, `.dev.vars`, or local archive files in source control. For local development, use an untracked `.dev.vars` file and local Wrangler bindings; do not reuse production secrets casually.

### Cloud edition limitations

- A Cloudflare Worker cannot use the local app's arbitrary HTTP/SOCKS5 proxy setting; X requests use Cloudflare's outbound network. X may rate-limit or refuse some Cloudflare egress IPs.
- The Cloud edition supports JSON export; offline self-contained HTML export is currently only in the local Python edition.
- R2's 10 GB is a monthly free-tier allowance, not a hard storage cap. Usage beyond included storage/operations can incur charges. Monitor the account's R2 and D1 usage, and keep independent backups.
- X's internal web API is undocumented. Deleted, hidden, protected, or otherwise inaccessible replies cannot be recovered.

## Local Python edition

The original local-only application remains available as described below.

## Run on Windows

1. Install Python 3.10 or later.
2. Double-click `run.bat` (or run `python app.py`).
3. Open <http://127.0.0.1:5000>.
4. In **登录态与代理设置**, paste your own X cookie JSON export or a Cookie header containing `auth_token` and `ct0`.
   - By default, the cookie stays only in process memory and is cleared when the app exits.
   - Optionally enable **重启后保留登录态**. The cookie (and configured proxy) is Fernet-encrypted for storage, so it works on Windows and Linux and is not bound to a specific OS account. To migrate the app, copy both `data/session.enc` and `data/session.key`; protect those files, since anyone who gets both can decrypt the saved login.
   - An optional HTTP(S) or SOCKS5 proxy can be applied or cleared independently. Supported forms include `socks5://` and `socks5h://`; `socks5h` resolves host names through the proxy. Proxy settings are included in encrypted persistence when enabled. `requests[socks]` installs SOCKS support.
5. Paste an X post URL and start saving.

The app binds only to `127.0.0.1`; do not change it to a public interface. The cookie should be treated like a password. Use a trusted local machine, do not share the cookie, and clear/revoke the session if it has been exposed.

On the archive list, **删除单条** removes only that local archive and its cover. **删除全部** requires typing `删除全部` and removes every local archive and cover; neither action changes or deletes anything on X. Bulk deletion is refused while a task is actively running.

## What is saved

- Original post URL, text, author, timestamp, available cover image, replies and reply-to relationships.
- A local preview at `/task/<id>`, offline HTML export (cover embedded), and JSON export at `/export/<id>.json`.
- Raw API pages are retained in the JSON export to help diagnose X response changes.

The app marks a task **partial** when X reports more replies than the endpoint returned, or pagination did not reach its end. It cannot recover deleted, hidden, protected, or otherwise inaccessible content. X's internal web API is undocumented and may change or rate-limit access.

## Data location

For the local edition, SQLite archive data, downloaded media, and (only when the optional persistence setting is enabled) the encrypted login session are stored under `data/`. Back up the whole folder if you want to retain local archives and persistent login. `data/session.enc` and `data/session.key` together can decrypt the saved local session, so protect both files and do not upload them. To erase local data, stop the app and remove that folder.

For the Cloud edition, metadata and encrypted X cookies are stored in your D1 database and downloaded media is stored in your private R2 bucket. Back up these resources independently; deleting an archive through the app removes that archive's associated media but does not export a backup for you.
