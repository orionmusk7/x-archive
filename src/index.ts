interface ArchiveRow {
  id: string;
  post_id: string;
  source_url: string;
  status: string;
  progress: number;
  stage: string;
  reply_count: number | null;
  fetched_count: number;
  post_json: string | null;
  replies_json: string | null;
  raw_json: string | null;
  cover_key: string | null;
  error: string | null;
  cursor: string | null;
  pages_done: number;
  retry_count: number;
  lease_until: number;
  created_at: string;
  updated_at: string;
}

interface MediaDescriptor {
  type: "image" | "video";
  alt?: string;
  file?: string;
  poster_file?: string;
  error?: string;
  poster_error?: string;
}

interface SavedTweet {
  id: string;
  parent_id?: string;
  author: string;
  name: string;
  avatar: string;
  created_at: string;
  text: string;
  entities: Record<string, unknown>;
  raw?: Record<string, unknown>;
  attachments?: MediaDescriptor[];
}

interface XPayload {
  globalObjects?: {
    users?: Record<string, Record<string, unknown>>;
    tweets?: Record<string, Record<string, unknown>>;
  };
  timeline?: { instructions?: Array<Record<string, unknown>> };
}

const SESSION_COOKIE = "xsv_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW = 15 * 60;
const LOGIN_LIMIT = 8;
const MAX_PAGES_PER_JOB = 1;
const MAX_TOTAL_PAGES = 100;
// R2 single-request uploads are limited to 5 GiB minus 5 MiB.
const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const API_URL = "https://x.com/i/api/2/timeline/conversation/";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message: string, status: number): Response {
  return json({ ok: false, error: message }, status);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function linkify(value: string): string {
  const pattern = /(https?:\/\/[^\s<]+|(?<![\w/])@[A-Za-z0-9_]{1,15})/g;
  let output = "";
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    output += escapeHtml(value.slice(offset, index));
    const text = match[0];
    if (text.startsWith("http")) {
      const url = text.replace(/[.,!?;:)\]}"']+$/, "");
      const tail = text.slice(url.length);
      output += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(tail)}`;
    } else {
      const handle = text.slice(1);
      output += `<a href="https://x.com/${encodeURIComponent(handle)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
    }
    offset = index + text.length;
  }
  return output + escapeHtml(value.slice(offset)).replace(/\n/g, "<br>");
}

function parsePostId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(url.hostname.toLowerCase())) return null;
    return url.pathname.match(/^\/[^/]+\/status\/(\d{1,30})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function findCursor(payload: XPayload): string | null {
  let fallback: string | null = null;
  for (const instruction of payload.timeline?.instructions ?? []) {
    const entries = (instruction.addEntries as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ?? [];
    for (const entry of entries) {
      const cursor = (entry.content as { operation?: { cursor?: { value?: string; cursorType?: string } } } | undefined)?.operation?.cursor;
      if (!cursor?.value) continue;
      if (cursor.cursorType?.toLowerCase() === "bottom") return cursor.value;
      fallback ??= cursor.value;
    }
  }
  return fallback;
}

function parseCookies(value: string): Record<string, string> {
  let pairs: Record<string, string>;
  const raw = value.trim();
  if (!raw || raw.length > 32768) throw new Error("请粘贴有效的 Cookie（最大 32 KB）。");
  if (raw.startsWith("{") || raw.startsWith("[")) {
    const data: unknown = JSON.parse(raw);
    const source = data && typeof data === "object" && !Array.isArray(data) && "cookies" in data
      ? (data as { cookies: unknown }).cookies : data;
    if (Array.isArray(source)) {
      pairs = Object.fromEntries(source.flatMap((item) => {
        if (!item || typeof item !== "object" || !("name" in item) || !("value" in item)) return [];
        return [[String(item.name), String(item.value)]];
      }));
    } else if (source && typeof source === "object") {
      pairs = Object.fromEntries(Object.entries(source).map(([key, val]) => [key, String(val)]));
    } else throw new Error("无法识别 Cookie 格式。");
  } else {
    pairs = Object.fromEntries(raw.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index < 1 ? [] : [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
    }));
  }
  if (!pairs.auth_token || !pairs.ct0) throw new Error("Cookie 中需要 auth_token 和 ct0。");
  for (const [key, val] of Object.entries(pairs)) {
    if (!/^[\w-]{1,128}$/.test(key) || /[\r\n;]/.test(val)) throw new Error("Cookie 包含无效字符。");
  }
  return pairs;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function equalSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

async function session(request: Request, env: Env): Promise<{ token: string; expires: number } | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,48}$/.test(token)) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash=? AND expires_at>? LIMIT 1")
    .bind(hash, Math.floor(Date.now() / 1000)).first<{ expires_at: number }>();
  return row ? { token, expires: row.expires_at } : null;
}

function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function loginPage(): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>登录 · X Thread Saver</title><link rel="stylesheet" href="/styles.css"></head><body class="login-body"><main class="login-shell"><p class="eyebrow">PRIVATE ARCHIVE</p><h1>只属于你的<br>收藏室。</h1><p class="intro">输入访问密码以进入 X Thread Saver。登录在此设备保持 30 天，并会在使用时自动续期。</p><form id="login-form" class="login-panel"><label for="password">访问密码</label><input id="password" type="password" autocomplete="current-password" required maxlength="1024"><button class="primary" type="submit">登录</button><p id="login-notice" class="notice" role="status" aria-live="polite"></p></form></main><script src="/login.js" defer></script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

async function readJson(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > maxBytes) throw new Error("请求内容过大。");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("请求内容过大。");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求格式无效。");
  return parsed as Record<string, unknown>;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const material = Uint8Array.from(atob(env.SESSION_ENCRYPTION_KEY), (char) => char.charCodeAt(0));
  if (material.length !== 32) throw new Error("Session encryption key must be 32 random bytes (base64).");
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSettings(value: unknown, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), data);
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv); packed.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...packed));
}

async function decryptSettings(value: string, env: Env): Promise<Record<string, string>> {
  const packed = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, await encryptionKey(env), packed.slice(12));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored settings are invalid.");
  return parsed as Record<string, string>;
}

async function getCookies(env: Env): Promise<Record<string, string> | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='x_cookies'").first<{ value: string }>();
  if (!row) return null;
  return decryptSettings(row.value, env);
}

async function mediaEntries(tweet: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const extended = (tweet.extended_entities as { media?: Array<Record<string, unknown>> } | undefined)?.media;
  const ordinary = (tweet.entities as { media?: Array<Record<string, unknown>> } | undefined)?.media;
  return extended?.length ? extended : ordinary ?? [];
}

function videoUrl(media: Record<string, unknown>): string | null {
  const variants = (media.video_info as { variants?: Array<Record<string, unknown>> } | undefined)?.variants ?? [];
  const candidates = variants.filter((item) => item.content_type === "video/mp4" && typeof item.url === "string");
  candidates.sort((left, right) => Number(right.bitrate ?? 0) - Number(left.bitrate ?? 0));
  if (typeof candidates[0]?.url !== "string") return null;
  try {
    const url = new URL(candidates[0].url);
    return url.protocol === "https:" && url.hostname.endsWith(".twimg.com") ? url.href : null;
  } catch { return null; }
}

function imageOriginalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".twimg.com")) return null;
    url.pathname = url.pathname.replace(/:[^/]+$/, "");
    url.searchParams.set("name", "orig");
    return url.href;
  } catch { return null; }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "抓取失败。";
  return message.replace(/(?:auth_token|ct0)=([^;\s]+)/gi, "$1=[redacted]").slice(0, 500);
}

async function uploadMedia(env: Env, taskId: string, tweetId: string, index: number, media: Record<string, unknown>): Promise<{ item: MediaDescriptor; poster: string | null }> {
  const isVideo = media.type === "video" || media.type === "animated_gif" || Boolean(media.video_info);
  const kind = isVideo ? "video" : "image";
  const posterUrl = imageOriginalUrl(String(media.media_url_https ?? media.media_url ?? ""));
  const sourceUrl = isVideo ? videoUrl(media) : posterUrl;
  const item: MediaDescriptor = { type: kind, alt: String(media.ext_alt_text ?? "") };
  if (!sourceUrl) return { item: { ...item, error: "X 没有提供可下载的媒体地址。" }, poster: null };

  const response = await fetch(sourceUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) return { item: { ...item, error: `媒体下载失败（HTTP ${response.status}）。` }, poster: null };
  const declaredLength = Number(response.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_MEDIA_BYTES) return { item: { ...item, error: "媒体超过 Cloudflare R2 单次上传上限（约 4.995 GiB）。" }, poster: null };
  const contentType = kind === "video" ? "video/mp4" : (response.headers.get("Content-Type")?.split(";")[0] || "image/jpeg");
  if (kind === "image" && !contentType.startsWith("image/")) return { item: { ...item, error: "X 返回的内容不是图片。" }, poster: null };
  const suffix = kind === "video" ? "mp4" : contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
  const key = `${taskId}/${tweetId}-media-${index}.${suffix}`;
  let receivedBytes = 0;
  const limitedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_MEDIA_BYTES) throw new Error("媒体超过 Cloudflare R2 单次上传上限（约 4.995 GiB）。");
      controller.enqueue(chunk);
    },
  }));
  await env.ARCHIVE_MEDIA.put(key, limitedBody, { httpMetadata: { contentType, cacheControl: "private, max-age=0, no-store" } });
  item.file = key;
  if (kind === "image") item.poster_file = key;
  else if (posterUrl) {
    try {
      const poster = await fetch(posterUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
      if (poster.ok && poster.body) {
        const posterKey = `${taskId}/${tweetId}-poster-${index}.jpg`;
        await env.ARCHIVE_MEDIA.put(posterKey, poster.body, { httpMetadata: { contentType: "image/jpeg", cacheControl: "private, max-age=0, no-store" } });
        item.poster_file = posterKey;
      }
    } catch { /* The thumbnail is optional; preserve the video. */ }
  }
  return { item, poster: item.poster_file ?? null };
}

async function saveTweetMedia(env: Env, taskId: string, tweet: Record<string, unknown>, id: string): Promise<{ assets: MediaDescriptor[]; coverKey: string | null }> {
  const entries = await mediaEntries(tweet);
  const assets: MediaDescriptor[] = [];
  let coverKey: string | null = null;
  for (let index = 0; index < entries.length; index++) {
    try {
      const result = await uploadMedia(env, taskId, id, index, entries[index]);
      assets.push(result.item);
      coverKey ??= result.poster;
    } catch (error) {
      const isVideo = entries[index].type === "video" || Boolean(entries[index].video_info);
      assets.push({ type: isVideo ? "video" : "image", error: safeError(error) });
    }
  }
  return { assets, coverKey };
}

function normalizedTweet(id: string, tweet: Record<string, unknown>, users: Record<string, Record<string, unknown>>, rootId: string): SavedTweet {
  const user = users[String(tweet.user_id_str ?? "")] ?? {};
  return {
    id,
    parent_id: String(tweet.in_reply_to_status_id_str ?? rootId),
    author: String(user.screen_name ?? ""),
    name: String(user.name ?? ""),
    avatar: String(user.profile_image_url_https ?? ""),
    created_at: String(tweet.created_at ?? ""),
    text: String(tweet.full_text ?? tweet.text ?? ""),
    entities: (tweet.entities as Record<string, unknown>) ?? {},
    raw: tweet,
  };
}

async function processQueueMessage(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT * FROM archives WHERE id=?").bind(taskId).first<ArchiveRow>();
  if (!row || !["queued", "running"].includes(row.status)) return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare("UPDATE archives SET status='running',lease_until=?,updated_at=? WHERE id=? AND (status='queued' OR (status='running' AND lease_until<?))")
    .bind(nowSeconds + 900, new Date().toISOString(), taskId, nowSeconds).run();
  if (!claimed.meta.changes) return false;
  const cookieMap = await getCookies(env);
  if (!cookieMap) throw new Error("尚未设置 X 登录 Cookie。请先在设置中配置自己的 Cookie 后重试。");
  const headers = new Headers({
    Authorization: `Bearer ${BEARER}`,
    Cookie: cookieHeader(cookieMap),
    "x-csrf-token": cookieMap.ct0,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: "https://x.com/",
  });
  let cursor = row.cursor;
  let root: Record<string, unknown> | null = row.post_json ? (JSON.parse(row.post_json) as SavedTweet).raw ?? null : null;
  const replies: SavedTweet[] = row.replies_json ? JSON.parse(row.replies_json) as SavedTweet[] : [];
  const allUsers: Record<string, Record<string, unknown>> = {};
  const seenIds = new Set(replies.map((item) => item.id));
  let finished = false;
  let expected = row.reply_count ?? 0;

  await env.DB.prepare("UPDATE archives SET status='running',stage=?,updated_at=? WHERE id=?")
    .bind("正在连接 X 并读取回复…", new Date().toISOString(), taskId).run();

  let pagesProcessed = 0;
  for (let page = 0; page < MAX_PAGES_PER_JOB && !finished; page++) {
    const url = new URL(`${API_URL}${row.post_id}.json`);
    url.searchParams.set("count", "100");
    url.searchParams.set("tweet_mode", "extended");
    url.searchParams.set("include_reply_count", "1");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (response.status === 429) throw new Error("X 暂时限流（HTTP 429），稍后可重试。");
    if (response.status === 401 || response.status === 403) throw new Error(`X 拒绝了 Cookie（HTTP ${response.status}），请更新 Cookie 后重试。`);
    if (!response.ok) throw new Error(`X 请求失败（HTTP ${response.status}）。`);
    const payload = await response.json() as XPayload;
    pagesProcessed++;
    const globals = payload.globalObjects ?? {};
    const users = globals.users ?? {};
    Object.assign(allUsers, users);
    const tweets = globals.tweets ?? {};
    for (const [tweetId, tweet] of Object.entries(tweets)) {
      if (tweetId === row.post_id) root = tweet;
      else if (!seenIds.has(tweetId)) { replies.push(normalizedTweet(tweetId, tweet, allUsers, row.post_id)); seenIds.add(tweetId); }
    }
    expected = Number(root?.reply_count ?? expected);
    const next = findCursor(payload);
    if (!next || next === cursor || !Object.values(tweets).length || row.pages_done + pagesProcessed >= MAX_TOTAL_PAGES) finished = true;
    else cursor = next;
  }

  if (!root) throw new Error("接口未返回原帖，请确认链接有效且当前 X 账号可以访问。");
  const existingPost: SavedTweet | null = row.post_json ? JSON.parse(row.post_json) as SavedTweet : null;
  const rootUser = allUsers[String(root.user_id_str ?? "")] ?? {};
  const post: SavedTweet = existingPost ? { ...existingPost, raw: root } : {
    id: row.post_id,
    author: String(rootUser.screen_name ?? ""),
    name: String(rootUser.name ?? ""),
    avatar: String(rootUser.profile_image_url_https ?? ""),
    created_at: String(root.created_at ?? ""),
    text: String(root.full_text ?? root.text ?? ""),
    entities: (root.entities as Record<string, unknown>) ?? {},
    raw: root,
  };
  let rootMedia = { assets: post.attachments ?? [], coverKey: row.cover_key };
  if (!post.attachments || post.attachments.some((asset) => Boolean(asset.error))) {
    rootMedia = await saveTweetMedia(env, taskId, root, row.post_id);
    post.attachments = rootMedia.assets;
  }
  const allAssets: MediaDescriptor[] = [...(post.attachments ?? [])];
  for (const reply of replies) {
    if (reply.raw && (!reply.attachments || reply.attachments.some((asset) => Boolean(asset.error)))) {
      const media = await saveTweetMedia(env, taskId, reply.raw, reply.id);
      reply.attachments = media.assets;
    }
    allAssets.push(...(reply.attachments ?? []));
  }
  const mediaFailed = allAssets.some((item) => Boolean(item.error));
  const pagesDone = row.pages_done + pagesProcessed;
  const complete = finished && replies.length >= expected && !mediaFailed;
  const status = finished ? complete ? "saved" : "partial" : "running";
  const progress = finished ? 100 : Math.min(95, 10 + Math.floor((pagesDone / MAX_TOTAL_PAGES) * 85));
  const stage = finished ? (complete ? "已保存" : `部分完成 · 回复 ${replies.length} / ${expected} 条${mediaFailed ? " · 有媒体未能下载" : ""}`) : `正在读取回复 · 已取得 ${replies.length} 条 / X 显示 ${expected} 条`;
  await env.DB.prepare("UPDATE archives SET status=?,progress=?,stage=?,reply_count=?,fetched_count=?,post_json=?,replies_json=?,cover_key=COALESCE(?,cover_key),cursor=?,pages_done=?,retry_count=0,lease_until=0,error=NULL,updated_at=? WHERE id=?")
    .bind(status, progress, stage, expected, replies.length, JSON.stringify(post), JSON.stringify(replies), rootMedia.coverKey, finished ? null : cursor, pagesDone, new Date().toISOString(), taskId).run();
  if (!finished) await env.ARCHIVE_QUEUE.send({ taskId });
  return true;
}

function taskView(row: ArchiveRow): Record<string, unknown> {
  let preview = "";
  try { preview = row.post_json ? (JSON.parse(row.post_json) as SavedTweet).text.slice(0, 180) : ""; } catch { /* malformed archive is shown without preview */ }
  return { id: row.id, url: row.source_url, post_id: row.post_id, status: row.status, progress: row.progress, stage: row.stage, reply_count: row.reply_count, fetched_count: row.fetched_count, created_at: row.created_at, updated_at: row.updated_at, error: row.error, cover_file: row.cover_key, preview };
}

async function listTasks(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT * FROM archives ORDER BY created_at DESC LIMIT 100").all<ArchiveRow>();
  return json({ tasks: (result.results ?? []).map(taskView) });
}

function mediaHtml(assets: MediaDescriptor[] | undefined, taskId: string, compact = false): string {
  if (!assets?.length) return "";
  return `<div class="${compact ? "reply-media" : "media-stack"}">${assets.map((asset) => {
    if (asset.error) return `<div class="media-error">媒体未能保存：${escapeHtml(asset.error)}</div>`;
    const src = asset.file ? `/api/media/${encodeURIComponent(taskId)}?key=${encodeURIComponent(asset.file)}` : "";
    const poster = asset.poster_file ? `/api/media/${encodeURIComponent(taskId)}?key=${encodeURIComponent(asset.poster_file)}` : "";
    if (asset.type === "video" && src) return `<video class="media-view" controls preload="metadata" ${poster ? `poster="${poster}"` : ""}><source src="${src}" type="video/mp4">浏览器无法播放此视频。</video>`;
    if (asset.type === "image" && src) return `<img class="media-view" src="${src}" alt="${escapeHtml(asset.alt || "帖子图片")}" loading="lazy">`;
    return "";
  }).join("")}</div>`;
}

function buildTree(replies: SavedTweet[], rootId: string): Array<SavedTweet & { children: Array<SavedTweet & { children: never[] }> }> {
  const nodes = new Map(replies.map((reply) => [reply.id, { ...reply, children: [] as Array<SavedTweet & { children: never[] }> }]));
  const roots: Array<SavedTweet & { children: Array<SavedTweet & { children: never[] }> }> = [];
  for (const reply of replies) {
    const node = nodes.get(reply.id)!;
    const parent = nodes.get(reply.parent_id ?? "");
    if (parent && reply.parent_id !== reply.id) parent.children.push(node as never);
    else if (reply.parent_id === rootId || !nodes.has(reply.parent_id ?? "")) roots.push(node);
  }
  return roots;
}

function renderReply(node: SavedTweet & { children: Array<SavedTweet & { children: never[] }> }, taskId: string): string {
  return `<article class="reply"><div class="reply-head"><strong>${escapeHtml(node.name || node.author || "Unknown account")}</strong><span>@${escapeHtml(node.author)}</span><time>${escapeHtml(node.created_at)}</time></div><div class="reply-text">${linkify(node.text)}</div>${mediaHtml(node.attachments, taskId, true)}${node.children.map((child) => renderReply(child, taskId)).join("")}</article>`;
}

async function renderDetail(row: ArchiveRow, env: Env): Promise<Response> {
  if (!row.post_json) {
    const shell = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>归档详情 · X Thread Saver</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell" id="app" data-view="detail" data-id="${escapeHtml(row.id)}"><header class="detail-top"><a href="/">← 回到归档</a><span>LOCAL ARCHIVE</span></header><div class="kicker">Saved conversation <span class="state ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></div><h1>${escapeHtml(row.stage)}</h1><p>${escapeHtml(row.error ?? "任务进行中…")} · ${row.progress}%</p><div class="progress"><span style="width:${Math.min(100, row.progress)}%"></span></div><button class="button" data-action="retry" data-id="${escapeHtml(row.id)}">重试</button></main><script src="/app.js" defer></script></body></html>`;
    return new Response(shell, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const post = JSON.parse(row.post_json) as SavedTweet;
  const replies = JSON.parse(row.replies_json ?? "[]") as SavedTweet[];
  const postUrl = escapeHtml(row.source_url);
  const postHtml = `<article class="post"><div><div class="author">${escapeHtml(post.name || post.author)}</div><div class="handle">@${escapeHtml(post.author)}</div><div class="posttext">${linkify(post.text)}</div><div class="date">${escapeHtml(post.created_at)}</div><div class="actions"><a class="button" href="${postUrl}" target="_blank" rel="noopener noreferrer">打开原帖 ↗</a><a class="button" href="/api/export/${encodeURIComponent(row.id)}.json">下载 JSON</a><button class="button" data-action="retry" data-id="${escapeHtml(row.id)}">重新抓取并补全</button><button class="button danger" data-action="delete-detail" data-id="${escapeHtml(row.id)}">删除本地归档</button></div></div>${mediaHtml(post.attachments, row.id)}</article>`;
  const content = `<section class="section"><div class="section-head"><h2>评论与回复</h2><span class="sub">${row.fetched_count} SAVED${row.reply_count != null ? ` / ${row.reply_count} REPORTED BY X` : ""}</span></div>${row.status === "partial" ? `<div class="warning">${escapeHtml(row.stage)}。X 的接口可能遗漏隐藏、删除或无法访问的回复。</div>` : ""}${replies.length ? buildTree(replies, row.post_id).map((node) => renderReply(node, row.id)).join("") : `<div class="empty">尚无可显示的回复。</div>`}</section>`;
  const detailBody = `<header class="detail-top"><a href="/">← 回到归档</a><span>LOCAL ARCHIVE</span></header><div class="kicker">Saved conversation <span class="state ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></div><h1>${escapeHtml(post.name || post.author || "帖子归档")}</h1><div class="source"><a href="${postUrl}" target="_blank" rel="noopener noreferrer">${postUrl}</a></div>${row.error ? `<div class="warning">${escapeHtml(row.error)} <button class="button" data-action="retry" data-id="${escapeHtml(row.id)}">重试</button></div>` : ""}${postHtml}${content}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>归档详情 · X Thread Saver</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell" id="app" data-view="detail" data-id="${escapeHtml(row.id)}">${detailBody}</main><script src="/app.js" defer></script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.APP_PASSWORD) return errorResponse("访问密码尚未在 Cloudflare secrets 中配置。", 503);
  if (!sameOrigin(request)) return errorResponse("请求来源验证失败。", 403);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = await sha256(ip);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT count,window_started,blocked_until FROM login_attempts WHERE ip_hash=?").bind(ipHash)
    .first<{ count: number; window_started: number; blocked_until: number }>();
  if (row && row.blocked_until > now) return errorResponse("登录尝试过多，请稍后再试。", 429);
  let body: Record<string, unknown>;
  try { body = await readJson(request, 4096); } catch { return errorResponse("登录请求无效。", 400); }
  const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
  const valid = await equalSecret(password, env.APP_PASSWORD);
  if (!valid) {
    const count = row && now - row.window_started < LOGIN_WINDOW ? row.count + 1 : 1;
    const windowStarted = row && now - row.window_started < LOGIN_WINDOW ? row.window_started : now;
    const blockedUntil = count >= LOGIN_LIMIT ? now + LOGIN_WINDOW : 0;
    await env.DB.prepare("INSERT INTO login_attempts(ip_hash,count,window_started,blocked_until) VALUES(?,?,?,?) ON CONFLICT(ip_hash) DO UPDATE SET count=excluded.count,window_started=excluded.window_started,blocked_until=excluded.blocked_until")
      .bind(ipHash, count, windowStarted, blockedUntil).run();
    return errorResponse("密码不正确。", 401);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip_hash=?").bind(ipHash).run();
  const token = randomToken();
  const hash = await sha256(token);
  await env.DB.prepare("INSERT INTO sessions(token_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?)")
    .bind(hash, now, now + SESSION_SECONDS, now).run();
  return json({ ok: true }, 200, { "Set-Cookie": setSessionCookie(token) });
}

async function authenticatedFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const isLoginApi = path === "/api/auth/login" && request.method === "POST";
  const isLogoutApi = path === "/api/auth/logout" && request.method === "POST";
  const isPublic = path === "/login" || path === "/login.html" || path === "/login.js" || path === "/styles.css" || path === "/favicon.ico" || path === "/api/auth/me" || isLoginApi;

  if (isLoginApi) return handleLogin(request, env);
  const authenticated = await session(request, env);
  if (isPublic && request.method === "GET") {
    if (path === "/api/auth/me") return json({ authenticated: Boolean(authenticated) });
    if ((path === "/login" || path === "/login.html") && authenticated) return Response.redirect(new URL("/", request.url), 302);
    if (path === "/login" || path === "/login.html") return loginPage();
    const assetPath = path;
    const asset = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
    return asset;
  }

  if (!authenticated) {
    if (path.startsWith("/api/")) return errorResponse("请先登录。", 401);
    return Response.redirect(new URL("/login", request.url), 302);
  }
  const now = Math.floor(Date.now() / 1000);
  if (authenticated.expires - now < 5 * 24 * 60 * 60) {
    const newExpiry = now + SESSION_SECONDS;
    ctx.waitUntil(env.DB.prepare("UPDATE sessions SET expires_at=?,last_seen_at=? WHERE token_hash=?")
      .bind(newExpiry, now, await sha256(authenticated.token)).run());
    // Refresh the browser cookie alongside the server-side sliding expiry.
  }

  if ((request.method === "POST" || request.method === "DELETE" || request.method === "PUT" || request.method === "PATCH") && !sameOrigin(request)) {
    return errorResponse("请求来源验证失败。", 403);
  }

  if (isLogoutApi) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(authenticated.token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }
  if (path === "/api/auth/me" && request.method === "GET") return json({ authenticated: true });
  if (path === "/api/settings" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='x_cookies'").first<{ value: string }>();
    return json({ cookie_ready: Boolean(row), cookie_persistent: Boolean(row) });
  }
  if (path === "/api/settings" && request.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await readJson(request); } catch (error) { return errorResponse(safeError(error), 400); }
    try {
      const cookies = parseCookies(String(body.cookie ?? ""));
      const value = await encryptSettings(cookies, env);
      await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('x_cookies',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(value, new Date().toISOString()).run();
      return json({ ok: true, message: "X 登录 Cookie 已加密保存；有效期由 X 决定。" });
    } catch (error) { return errorResponse(safeError(error), 400); }
  }
  if (path === "/api/settings" && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM settings WHERE key='x_cookies'").run();
    return json({ ok: true });
  }
  if (path === "/api/tasks" && request.method === "GET") return listTasks(env);
  if (path === "/api/tasks" && request.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await readJson(request, 8192); } catch (error) { return errorResponse(safeError(error), 400); }
    const sourceUrl = typeof body.url === "string" ? body.url.trim() : "";
    const postId = parsePostId(sourceUrl);
    if (!postId) return errorResponse("请输入有效的 X/Twitter 帖子链接。", 400);
    const settings = await env.DB.prepare("SELECT 1 AS found FROM settings WHERE key='x_cookies'").first();
    if (!settings) return errorResponse("请先在登录态设置中保存 X Cookie。", 400);
    const existing = await env.DB.prepare("SELECT * FROM archives WHERE post_id=? AND status IN ('saved','partial','queued','running') ORDER BY created_at DESC LIMIT 1").bind(postId).first<ArchiveRow>();
    if (existing) return json({ ok: true, existing: true, task: taskView(existing) });
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const stamp = new Date().toISOString();
    await env.DB.prepare("INSERT INTO archives(id,post_id,source_url,status,progress,stage,created_at,updated_at) VALUES(?,?,?,'queued',0,'排队中',?,?)")
      .bind(id, postId, sourceUrl, stamp, stamp).run();
    await env.ARCHIVE_QUEUE.send({ taskId: id });
    return json({ ok: true, task_id: id }, 202);
  }
  if (path === "/api/tasks" && request.method === "DELETE") {
    const running = await env.DB.prepare("SELECT COUNT(*) AS count FROM archives WHERE status IN ('queued','running')").first<{ count: number }>();
    if (Number(running?.count ?? 0) > 0) return errorResponse("有任务正在运行，请等它完成后再清空。", 409);
    const rows = await env.DB.prepare("SELECT id FROM archives").all<{ id: string }>();
    await env.DB.prepare("DELETE FROM archives").run();
    for (const item of rows.results ?? []) await deleteMediaPrefix(env, `${item.id}/`);
    return json({ ok: true, deleted: rows.results?.length ?? 0 });
  }
  const retry = path.match(/^\/api\/tasks\/([a-f0-9-]{12,36})\/retry$/);
  if (retry && request.method === "POST") {
    const result = await env.DB.prepare("UPDATE archives SET status='queued',progress=0,stage='排队中',error=NULL,cursor=NULL,pages_done=0,retry_count=0,lease_until=0,updated_at=? WHERE id=? AND status NOT IN ('queued','running')")
      .bind(new Date().toISOString(), retry[1]).run();
    if (!result.meta.changes) return errorResponse("任务不存在或正在运行。", 404);
    await env.ARCHIVE_QUEUE.send({ taskId: retry[1] });
    return json({ ok: true });
  }
  const singleDelete = path.match(/^\/api\/tasks\/([a-f0-9-]{12,36})$/);
  if (singleDelete && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT status FROM archives WHERE id=?").bind(singleDelete[1]).first<{ status: string }>();
    if (!row) return errorResponse("归档不存在。", 404);
    if (["queued", "running"].includes(row.status)) return errorResponse("任务正在运行，完成后再删除。", 409);
    await env.DB.prepare("DELETE FROM archives WHERE id=?").bind(singleDelete[1]).run();
    await deleteMediaPrefix(env, `${singleDelete[1]}/`);
    return json({ ok: true });
  }
  const detail = path.match(/^\/task\/([a-f0-9-]{12,36})$/);
  if (detail && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM archives WHERE id=?").bind(detail[1]).first<ArchiveRow>();
    if (!row) return errorResponse("归档不存在。", 404);
    return renderDetail(row, env);
  }
  const apiDetail = path.match(/^\/api\/tasks\/([a-f0-9-]{12,36})$/);
  if (apiDetail && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM archives WHERE id=?").bind(apiDetail[1]).first<ArchiveRow>();
    if (!row) return errorResponse("归档不存在。", 404);
    return json({ task: taskView(row), post: row.post_json ? JSON.parse(row.post_json) : null, replies: row.replies_json ? JSON.parse(row.replies_json) : [] });
  }
  const mediaMatch = path.match(/^\/api\/media\/([a-f0-9-]{12,36})$/);
  if (mediaMatch && (request.method === "GET" || request.method === "HEAD")) {
    const taskId = mediaMatch[1];
    const key = url.searchParams.get("key") ?? "";
    if (!key.startsWith(`${taskId}/`) || key.length > 1024) return errorResponse("媒体不存在。", 404);
    const row = await env.DB.prepare("SELECT id FROM archives WHERE id=?").bind(taskId).first();
    if (!row) return errorResponse("归档不存在。", 404);
    const rangeHeader = request.headers.get("Range");
    let range: R2Range | undefined;
    if (rangeHeader) {
      const parsed = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */*", "Accept-Ranges": "bytes" } });
      if (!parsed[1]) range = { suffix: Number(parsed[2]) };
      else {
        const offset = Number(parsed[1]);
        const end = parsed[2] ? Number(parsed[2]) : undefined;
        if (!Number.isSafeInteger(offset) || (end !== undefined && (!Number.isSafeInteger(end) || end < offset))) {
          return new Response(null, { status: 416, headers: { "Accept-Ranges": "bytes" } });
        }
        range = { offset, ...(end === undefined ? {} : { length: end - offset + 1 }) };
      }
    }
    const object = await env.ARCHIVE_MEDIA.get(key, range ? { range } : undefined);
    if (!object) return errorResponse("媒体文件不存在。", 404);
    const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
    object.writeHttpMetadata(headers);
    headers.set("Accept-Ranges", "bytes");
    let status = 200;
    if (rangeHeader && object.range && "offset" in object.range) {
      const start = object.range.offset ?? 0;
      const length = object.range.length ?? object.size - start;
      const end = start + length - 1;
      if (start >= object.size || length <= 0 || end >= object.size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${object.size}`, "Accept-Ranges": "bytes" } });
      }
      headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
      headers.set("Content-Length", String(length));
      status = 206;
    } else headers.set("Content-Length", String(object.size));
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
  }
  const exportJson = path.match(/^\/api\/export\/([a-f0-9-]{12,36})\.json$/);
  if (exportJson && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM archives WHERE id=?").bind(exportJson[1]).first<ArchiveRow>();
    if (!row) return errorResponse("归档不存在。", 404);
    const payload = { source_url: row.source_url, saved_at: row.updated_at, status: row.status, expected_reply_count: row.reply_count, fetched_reply_count: row.fetched_count, post: row.post_json ? JSON.parse(row.post_json) : null, replies: row.replies_json ? JSON.parse(row.replies_json) : [] };
    return json(payload, 200, { "Content-Disposition": `attachment; filename="x-thread-${row.post_id}.json"` });
  }
  if (path === "/" && request.method === "GET") return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  if (["/app.js", "/styles.css", "/login.js", "/favicon.ico"].includes(path) && request.method === "GET") return env.ASSETS.fetch(request);
  if (path.startsWith("/api/")) return errorResponse("接口不存在。", 404);
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function deleteMediaPrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.ARCHIVE_MEDIA.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length) await env.ARCHIVE_MEDIA.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let response: Response;
    let auth: { token: string; expires: number } | null = null;
    try {
      auth = await session(request, env);
      response = await authenticatedFetch(request, env, ctx);
    } catch (error) {
      response = errorResponse(safeError(error), 500);
    }
    const headers = new Headers(response.headers);
    if (auth && !headers.has("Set-Cookie") && auth.expires - Math.floor(Date.now() / 1000) < 5 * 24 * 60 * 60) headers.set("Set-Cookie", setSessionCookie(auth.token));
    for (const [name, value] of Object.entries(securityHeaders)) if (!headers.has(name)) headers.set(name, value);
    const publicStaticAsset = request.method === "GET" && ["/styles.css", "/login.js", "/favicon.ico"].includes(new URL(request.url).pathname);
    if (!publicStaticAsset) headers.set("Cache-Control", "no-store");
    else if (!headers.has("Cache-Control")) headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as { taskId?: unknown };
      if (typeof body.taskId !== "string" || !/^[a-f0-9-]{12,36}$/.test(body.taskId)) { message.ack(); continue; }
      try {
        const completed = await processQueueMessage(env, body.taskId);
        if (completed) message.ack();
        else message.retry({ delaySeconds: 300 });
      } catch (error) {
        const row = await env.DB.prepare("SELECT retry_count FROM archives WHERE id=?").bind(body.taskId).first<{ retry_count?: number }>();
        const attempts = Number(row?.retry_count ?? 0) + 1;
        await env.DB.prepare("UPDATE archives SET status=?,retry_count=?,lease_until=0,error=?,stage=?,updated_at=? WHERE id=?")
          .bind(attempts >= 3 ? "failed" : "queued", attempts, safeError(error), "抓取失败", new Date().toISOString(), body.taskId).run();
        if (attempts >= 3) message.ack(); else message.retry({ delaySeconds: Math.min(30 * attempts, 300) });
      }
    }
  },
} satisfies ExportedHandler<Env>;

export { escapeHtml, findCursor, imageOriginalUrl, linkify, parseCookies, parsePostId, videoUrl };
export default worker;

