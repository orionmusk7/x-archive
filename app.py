from __future__ import annotations

import html
import base64
import json
import mimetypes
import os
import queue
import re
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import requests
from cryptography.fernet import Fernet
from flask import Flask, abort, jsonify, make_response, redirect, render_template, request, send_from_directory, url_for
from markupsafe import Markup


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "archive.sqlite3"
SESSION_PATH = DATA_DIR / "session.enc"
SESSION_KEY_PATH = DATA_DIR / "session.key"
API_URL = "https://x.com/i/api/2/timeline/conversation/{post_id}.json"
# X's web-client bearer token is public client configuration, not an account credential.
WEB_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
MAX_PAGES = 100

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
DATA_DIR.mkdir(exist_ok=True)
MEDIA_DIR.mkdir(exist_ok=True)

jobs: queue.Queue[str] = queue.Queue()
active_lock = threading.Lock()
active_tasks: set[str] = set()
session_lock = threading.Lock()
session_cookies: dict[str, str] = {}
proxy_url = ""
session_persistent = False
session_notice = ""
worker_started = False
worker_lock = threading.Lock()


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                post_id TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                stage TEXT NOT NULL DEFAULT '',
                reply_count INTEGER,
                fetched_count INTEGER NOT NULL DEFAULT 0,
                post_json TEXT,
                replies_json TEXT,
                raw_json TEXT,
                cover_file TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                error TEXT
            )"""
        )
        conn.execute("UPDATE tasks SET status='queued', stage='等待抓取', updated_at=? WHERE status='running'", (now(),))
        for row in conn.execute("SELECT id FROM tasks WHERE status='queued'"):
            jobs.put(row["id"])


def _get_session_cipher(create: bool = False) -> Fernet:
    if SESSION_KEY_PATH.exists():
        key = SESSION_KEY_PATH.read_bytes()
    elif create:
        key = Fernet.generate_key()
        SESSION_KEY_PATH.write_bytes(key)
        try:
            SESSION_KEY_PATH.chmod(0o600)
        except OSError:
            pass
    else:
        raise RuntimeError("找不到登录态加密密钥；请恢复 data/session.key。")
    return Fernet(key)


def save_persistent_settings() -> None:
    if not session_persistent or not session_cookies:
        SESSION_PATH.unlink(missing_ok=True)
        SESSION_KEY_PATH.unlink(missing_ok=True)
        return
    payload = json.dumps({"cookies": session_cookies, "proxy_url": proxy_url}, ensure_ascii=False).encode("utf-8")
    encrypted = _get_session_cipher(create=True).encrypt(payload)
    temporary = SESSION_PATH.with_suffix(".tmp")
    temporary.write_bytes(encrypted)
    temporary.replace(SESSION_PATH)


def load_persistent_settings() -> None:
    global proxy_url, session_persistent, session_notice
    if not SESSION_PATH.exists():
        return
    try:
        settings = json.loads(_get_session_cipher().decrypt(SESSION_PATH.read_bytes()).decode("utf-8"))
        parsed = settings.get("cookies", {})
        if not parsed.get("auth_token") or not parsed.get("ct0"):
            raise ValueError("持久化登录态缺少必要字段。")
        with session_lock:
            session_cookies.clear()
            session_cookies.update({str(key): str(value) for key, value in parsed.items()})
            proxy_url = str(settings.get("proxy_url", ""))
            session_persistent = True
    except Exception:
        session_notice = "加密登录态无法读取；请重新设置登录态。"


def validate_proxy(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https", "socks5", "socks5h") or not parsed.hostname:
        raise ValueError("代理请使用完整的 http://、https://、socks5:// 或 socks5h:// 地址。")
    if any(char.isspace() for char in value):
        raise ValueError("代理地址不能包含空白字符。")
    return value


def safe_error(exc: Exception) -> str:
    message = str(exc)
    with session_lock:
        secrets = list(session_cookies.values()) + ([proxy_url] if proxy_url else [])
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[redacted]")
    return message[:500]


def remove_task_media(task_ids: list[str]) -> None:
    root = MEDIA_DIR.resolve()
    for task_id in task_ids:
        if not re.fullmatch(r"[a-f0-9]{12}", task_id):
            continue
        target = (MEDIA_DIR / task_id).resolve()
        if target.parent == root and target.exists():
            shutil.rmtree(target)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def update_task(task_id: str, **values: Any) -> None:
    values["updated_at"] = now()
    assignments = ", ".join(f"{key}=?" for key in values)
    with db() as conn:
        conn.execute(f"UPDATE tasks SET {assignments} WHERE id=?", (*values.values(), task_id))


def parse_post_id(value: str) -> str | None:
    match = re.search(r"(?:twitter|x)\.com/[^/?#]+/status/(\d+)", value.strip(), re.I)
    return match.group(1) if match else None


def parse_cookie_input(value: str) -> dict[str, str]:
    value = value.strip()
    if not value:
        raise ValueError("请粘贴 Cookie JSON 或 Cookie 请求头。")
    if value.startswith("{") or value.startswith("["):
        data = json.loads(value)
        if isinstance(data, dict) and isinstance(data.get("cookies"), list):
            data = data["cookies"]
        if isinstance(data, list):
            pairs = {str(item["name"]): str(item["value"]) for item in data if isinstance(item, dict) and "name" in item and "value" in item}
        elif isinstance(data, dict):
            pairs = {str(k): str(v) for k, v in data.items()}
        else:
            raise ValueError("无法识别 Cookie 格式。")
    else:
        pairs = {}
        for segment in value.split(";"):
            if "=" in segment:
                key, val = segment.strip().split("=", 1)
                pairs[key.strip()] = val.strip()
    if not pairs.get("auth_token") or not pairs.get("ct0"):
        raise ValueError("Cookie 中需要 auth_token 和 ct0。")
    return pairs


def x_headers(cookies: dict[str, str]) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {WEB_BEARER}",
        "x-csrf-token": cookies["ct0"],
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://x.com/",
    }


def find_cursor(payload: dict[str, Any]) -> str | None:
    fallback: str | None = None
    for instruction in payload.get("timeline", {}).get("instructions", []):
        for entry in instruction.get("addEntries", {}).get("entries", []):
            cursor = entry.get("content", {}).get("operation", {}).get("cursor", {})
            value = cursor.get("value")
            if not value:
                continue
            if str(cursor.get("cursorType", "")).lower() == "bottom":
                return value
            fallback = fallback or value
    return fallback


def fetch_conversation(post_id: str, task_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], int, dict[str, Any]]:
    with session_lock:
        cookies = dict(session_cookies)
        configured_proxy = proxy_url
    if not cookies:
        raise RuntimeError("尚未设置 X Cookie。请先在页面的“登录态”区域粘贴 Cookie。")

    client = requests.Session()
    client.trust_env = False
    client.cookies.update(cookies)
    if configured_proxy:
        client.proxies.update({"http": configured_proxy, "https": configured_proxy})
    headers = x_headers(cookies)
    cursor: str | None = None
    seen_cursors: set[str] = set()
    tweets: dict[str, dict[str, Any]] = {}
    users: dict[str, dict[str, Any]] = {}
    root: dict[str, Any] | None = None
    raw_pages: list[dict[str, Any]] = []
    finished = False

    for page in range(MAX_PAGES):
        params: dict[str, Any] = {"count": 100, "tweet_mode": "extended", "include_reply_count": 1}
        if cursor:
            params["cursor"] = cursor
        response = client.get(API_URL.format(post_id=post_id), params=params, headers=headers, timeout=30)
        if response.status_code == 429:
            raise RuntimeError("X 暂时限流了（HTTP 429）。稍后可以重试此任务。")
        if response.status_code in (401, 403):
            raise RuntimeError("X 拒绝了 Cookie（HTTP %s）。请更新 Cookie 后重试。" % response.status_code)
        response.raise_for_status()
        payload = response.json()
        raw_pages.append(payload)
        globals_ = payload.get("globalObjects", {})
        for user_id, user in globals_.get("users", {}).items():
            users[user_id] = user
        for tweet_id, tweet in globals_.get("tweets", {}).items():
            if tweet_id == post_id:
                root = tweet
            else:
                tweets[tweet_id] = tweet

        reply_count = int((root or {}).get("reply_count") or 0)
        update_task(task_id, progress=min(85, 18 + page * 4), stage=f"正在读取回复 · 已取得 {len(tweets)} 条 / X 显示 {reply_count} 条")

        next_cursor = find_cursor(payload)
        if not next_cursor or next_cursor in seen_cursors:
            finished = True
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    else:
        reply_count = int((root or {}).get("reply_count") or 0)

    if not root:
        raise RuntimeError("接口没有返回这条帖子。请确认链接有效，且当前账号可访问。")

    # Keep direct replies and descendants, using the parent ID to reconstruct the thread tree.
    normalized: list[dict[str, Any]] = []
    for tweet_id, tweet in tweets.items():
        user = users.get(str(tweet.get("user_id_str", "")), {})
        normalized.append({
            "id": tweet_id,
            "parent_id": str(tweet.get("in_reply_to_status_id_str") or post_id),
            "author": user.get("screen_name", ""),
            "name": user.get("name", ""),
            "avatar": user.get("profile_image_url_https", ""),
            "created_at": tweet.get("created_at", ""),
            "text": tweet.get("full_text") or tweet.get("text") or "",
            "entities": tweet.get("entities", {}),
            "raw": tweet,
        })
    normalized.sort(key=lambda item: item["created_at"])

    user = users.get(str(root.get("user_id_str", "")), {})
    post = {
        "id": post_id,
        "author": user.get("screen_name", ""),
        "name": user.get("name", ""),
        "avatar": user.get("profile_image_url_https", ""),
        "created_at": root.get("created_at", ""),
        "text": root.get("full_text") or root.get("text") or "",
        "entities": root.get("entities", {}),
        "reply_count": int(root.get("reply_count") or 0),
        "raw": root,
    }
    return post, normalized, int(root.get("reply_count") or 0), {"pages": raw_pages, "complete_cursor": finished}


def media_entries(tweet: dict[str, Any]) -> list[dict[str, Any]]:
    extended = tweet.get("extended_entities", {}).get("media", [])
    ordinary = tweet.get("entities", {}).get("media", [])
    return extended or ordinary


def download_media_file(url: str, path: Path, configured_proxy: str = "") -> None:
    client = requests.Session()
    client.trust_env = False
    if configured_proxy:
        client.proxies.update({"http": configured_proxy, "https": configured_proxy})
    partial = path.with_suffix(path.suffix + ".part")
    try:
        with client.get(url, timeout=(15, 90), headers={"User-Agent": "Mozilla/5.0"}, stream=True) as response:
            response.raise_for_status()
            with partial.open("wb") as output:
                for chunk in response.iter_content(chunk_size=256 * 1024):
                    if chunk:
                        output.write(chunk)
        if not partial.exists() or partial.stat().st_size == 0:
            raise RuntimeError("媒体响应为空")
        partial.replace(path)
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def video_variant_url(media: dict[str, Any]) -> str | None:
    variants = media.get("video_info", {}).get("variants", [])
    mp4s = [v for v in variants if v.get("content_type") == "video/mp4" and v.get("url")]
    if not mp4s:
        return None
    return max(mp4s, key=lambda item: int(item.get("bitrate") or 0))["url"]


def save_tweet_media(task_id: str, tweet: dict[str, Any], tweet_id: str, configured_proxy: str = "") -> tuple[list[dict[str, Any]], str | None]:
    entries = media_entries(tweet)
    if not entries:
        return [], None
    folder = MEDIA_DIR / task_id
    folder.mkdir(parents=True, exist_ok=True)
    attachments: list[dict[str, Any]] = []
    cover_file: str | None = None
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", str(tweet_id))[:40]

    for index, media in enumerate(entries):
        kind = "video" if media.get("type") in ("video", "animated_gif") or media.get("video_info") else "image"
        descriptor: dict[str, Any] = {"type": kind, "alt": media.get("ext_alt_text", "")}
        poster_url = media.get("media_url_https") or media.get("media_url")
        source_url = video_variant_url(media) if kind == "video" else poster_url
        if kind == "image" and source_url and ":" not in source_url.rsplit("/", 1)[-1]:
            source_url += ":orig"
        if kind == "video":
            suffix = ".mp4"
        else:
            image_format = urlsplit(source_url or "").query
            image_format = re.search(r"(?:^|&)format=(png|gif|webp|jpg|jpeg)(?:&|$)", image_format, re.I)
            suffix = "." + image_format.group(1).lower() if image_format else ".jpg"
        filename = f"{safe_id}-media-{index}{suffix}"
        target = folder / filename
        try:
            if not source_url:
                raise RuntimeError("X 没有提供可下载的媒体地址")
            if not target.is_file() or target.stat().st_size == 0:
                download_media_file(source_url, target, configured_proxy)
            descriptor["file"] = filename
            if poster_url and kind == "video":
                poster_name = f"{safe_id}-poster-{index}.jpg"
                poster_path = folder / poster_name
                try:
                    if not poster_path.is_file() or poster_path.stat().st_size == 0:
                        download_media_file(poster_url, poster_path, configured_proxy)
                    descriptor["poster_file"] = poster_name
                except Exception as exc:
                    # The video is the primary asset; a failed optional poster must not hide it.
                    descriptor["poster_error"] = str(exc)[:180]
            elif kind == "image":
                descriptor["poster_file"] = filename
            if cover_file is None:
                cover_file = descriptor.get("poster_file") or filename
        except Exception as exc:
            descriptor["error"] = str(exc)[:180]
        attachments.append(descriptor)
    return attachments, cover_file


def save_conversation_media(task_id: str, post: dict[str, Any], replies: list[dict[str, Any]], configured_proxy: str = "") -> tuple[str | None, bool]:
    post["attachments"], cover_file = save_tweet_media(task_id, post.get("raw", {}), post.get("id", "post"), configured_proxy)
    failed = any("error" in media for media in post["attachments"])
    for reply in replies:
        reply["attachments"], _ = save_tweet_media(task_id, reply.get("raw", {}), reply.get("id", "reply"), configured_proxy)
        failed = failed or any("error" in media for media in reply["attachments"])
    return cover_file, failed


def prepare_item_media(item: dict[str, Any], task_id: str, offline: bool = False) -> None:
    for asset in item.get("attachments", []):
        for source_key, file_key in (("src", "file"), ("poster_src", "poster_file")):
            filename = asset.get(file_key)
            if not filename:
                continue
            path = MEDIA_DIR / task_id / filename
            if not path.is_file():
                continue
            if offline:
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                asset[source_key] = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
            else:
                asset[source_key] = url_for("media", task_id=task_id, filename=filename)


def ensure_legacy_media(task_id: str, post: dict[str, Any], replies: list[dict[str, Any]], force: bool = False) -> str | None:
    has_errors = any("error" in media for media in post.get("attachments", [])) or any(
        "error" in media for reply in replies for media in reply.get("attachments", [])
    )
    if not force and "attachments" in post and all("attachments" in reply for reply in replies) and not has_errors:
        return None
    has_any = bool(media_entries(post.get("raw", {}))) or any(media_entries(reply.get("raw", {})) for reply in replies)
    if not has_any:
        return None
    with session_lock:
        configured_proxy = proxy_url
    cover_file, _ = save_conversation_media(task_id, post, replies, configured_proxy)
    with db() as conn:
        conn.execute(
            "UPDATE tasks SET post_json=?,replies_json=?,cover_file=COALESCE(?,cover_file),updated_at=? WHERE id=?",
            (json.dumps(post, ensure_ascii=False), json.dumps(replies, ensure_ascii=False), cover_file, now(), task_id),
        )
    return cover_file


def _process_task(task_id: str) -> None:
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        return
    update_task(task_id, status="running", progress=5, stage="连接 X…", error=None)
    try:
        post, replies, expected_count, raw_pages = fetch_conversation(row["post_id"], task_id)
        update_task(task_id, progress=86, stage="保存帖子及评论媒体…", fetched_count=len(replies), reply_count=expected_count)
        with session_lock:
            configured_proxy = proxy_url
        cover, media_failed = save_conversation_media(task_id, post, replies, configured_proxy)
        complete = len(replies) >= expected_count and raw_pages["complete_cursor"] and not media_failed
        status = "saved" if complete else "partial"
        stage = "已保存" if status == "saved" else f"部分完成 · 回复 {len(replies)} / {expected_count} 条" + (" · 有媒体未能下载" if media_failed else "")
        update_task(
            task_id,
            status=status,
            progress=100,
            stage=stage,
            fetched_count=len(replies),
            reply_count=expected_count,
            post_json=json.dumps(post, ensure_ascii=False),
            replies_json=json.dumps(replies, ensure_ascii=False),
            raw_json=json.dumps(raw_pages["pages"], ensure_ascii=False),
            cover_file=cover,
        )
    except Exception as exc:
        # Never include request headers or cookies in errors/logs.
        update_task(task_id, status="failed", stage="抓取失败", error=safe_error(exc))


def process_task(task_id: str) -> None:
    with active_lock:
        active_tasks.add(task_id)
    try:
        _process_task(task_id)
    finally:
        with active_lock:
            active_tasks.discard(task_id)


def worker() -> None:
    while True:
        task_id = jobs.get()
        try:
            process_task(task_id)
        finally:
            jobs.task_done()


def ensure_worker() -> None:
    global worker_started
    with worker_lock:
        if not worker_started:
            threading.Thread(target=worker, daemon=True, name="x-archive-worker").start()
            worker_started = True


def task_dict(row: sqlite3.Row) -> dict[str, Any]:
    result = {key: row[key] for key in ("id", "url", "post_id", "status", "progress", "stage", "reply_count", "fetched_count", "created_at", "updated_at", "error", "cover_file")}
    result["preview"] = ""
    if row["post_json"]:
        try:
            result["preview"] = json.loads(row["post_json"]).get("text", "")[:120]
        except (TypeError, json.JSONDecodeError):
            pass
    return result


def build_tree(replies: list[dict[str, Any]], post_id: str) -> list[dict[str, Any]]:
    nodes = {item["id"]: {**item, "children": []} for item in replies}
    roots = []
    for item in replies:
        node = nodes[item["id"]]
        parent = nodes.get(item["parent_id"])
        if parent and item["parent_id"] != item["id"]:
            parent["children"].append(node)
        else:
            roots.append(node)
    return roots


def linkify(value: str) -> Markup:
    escaped = html.escape(value, quote=True)
    pattern = re.compile(r"(https?://[^\s<]+|(?<![\w/])@[A-Za-z0-9_]{1,15})")
    chunks: list[str] = []
    pos = 0
    for match in pattern.finditer(escaped):
        chunks.append(escaped[pos:match.start()])
        text = match.group(0)
        if text.startswith("http"):
            url = text.rstrip(".,!?;:)]}\"'")
            tail = text[len(url):]
            chunks.append(f'<a href="{url}" target="_blank" rel="noopener noreferrer">{url}</a>{tail}')
        else:
            handle = text[1:]
            chunks.append(f'<a href="https://x.com/{quote(handle)}" target="_blank" rel="noopener noreferrer">{text}</a>')
        pos = match.end()
    chunks.append(escaped[pos:])
    return Markup("".join(chunks))


app.jinja_env.filters["linkify"] = linkify


@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index():
    with db() as conn:
        rows = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").fetchall()
    with session_lock:
        state = {"cookie_ready": bool(session_cookies), "cookie_persistent": session_persistent, "proxy_ready": bool(proxy_url)}
    items = [task_dict(row) for row in rows]
    return render_template("index.html", tasks=items, has_running=any(item["status"] == "running" for item in items), session_state=state, session_notice=session_notice)


@app.get("/api/settings")
def get_settings():
    with session_lock:
        return jsonify(cookie_ready=bool(session_cookies), cookie_persistent=session_persistent, proxy_ready=bool(proxy_url))


@app.post("/api/session")
def set_session():
    global session_persistent, session_notice
    body = request.get_json(silent=True) or {}
    cookie_text = str(body.get("cookie", "")).strip()
    try:
        parsed = parse_cookie_input(cookie_text) if cookie_text else None
    except (ValueError, json.JSONDecodeError) as exc:
        return jsonify(ok=False, error=str(exc)), 400
    with session_lock:
        if parsed is None and not session_cookies:
            return jsonify(ok=False, error="请粘贴 Cookie，或先设置登录态。"), 400
        previous = dict(session_cookies)
        previous_persistent = session_persistent
        if parsed is not None:
            session_cookies.clear()
            session_cookies.update(parsed)
        session_persistent = bool(body.get("persist", False))
        try:
            save_persistent_settings()
        except Exception as exc:
            session_cookies.clear()
            session_cookies.update(previous)
            session_persistent = previous_persistent
            return jsonify(ok=False, error=f"无法保存登录态：{exc}"), 500
        session_notice = ""
    if parsed is None:
        message = "登录态持久化已开启（Windows DPAPI 加密）。" if session_persistent else "已关闭登录态持久化；本次运行仍可使用当前登录态。"
    else:
        message = "登录态已用 Windows DPAPI 加密保存。" if session_persistent else "登录态只保存在当前进程内；重启后需要重新设置。"
    return jsonify(ok=True, message=message)


@app.delete("/api/session")
def clear_session():
    global session_persistent, session_notice
    with session_lock:
        session_cookies.clear()
        session_persistent = False
        session_notice = ""
        SESSION_PATH.unlink(missing_ok=True)
        SESSION_KEY_PATH.unlink(missing_ok=True)
    return jsonify(ok=True, message="已清除当前及持久化登录态。")


@app.post("/api/proxy")
def set_proxy():
    global proxy_url
    body = request.get_json(silent=True) or {}
    try:
        parsed = validate_proxy(str(body.get("proxy", "")))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    with session_lock:
        previous = proxy_url
        proxy_url = parsed
        try:
            if session_persistent:
                save_persistent_settings()
        except Exception as exc:
            proxy_url = previous
            return jsonify(ok=False, error=f"无法更新持久化设置：{exc}"), 500
    return jsonify(ok=True, message="代理设置已更新；地址不会回显。")


@app.delete("/api/proxy")
def clear_proxy():
    global proxy_url
    with session_lock:
        previous = proxy_url
        proxy_url = ""
        try:
            if session_persistent:
                save_persistent_settings()
        except Exception as exc:
            proxy_url = previous
            return jsonify(ok=False, error=f"无法更新持久化设置：{exc}"), 500
    return jsonify(ok=True, message="代理已清除。")


@app.post("/api/tasks")
def create_task():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url", "")).strip()
    post_id = parse_post_id(url)
    if not post_id:
        return jsonify(ok=False, error="请输入有效的 X/Twitter 帖子链接。"), 400
    if not session_cookies:
        return jsonify(ok=False, error="请先设置 X Cookie。"), 400
    with db() as conn:
        existing = conn.execute("SELECT * FROM tasks WHERE post_id=? AND status IN ('saved','partial') ORDER BY created_at DESC LIMIT 1", (post_id,)).fetchone()
        if existing:
            return jsonify(ok=True, existing=True, task=task_dict(existing))
        task_id = uuid.uuid4().hex[:12]
        stamp = now()
        conn.execute(
            "INSERT INTO tasks(id,url,post_id,status,progress,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (task_id, url, post_id, "queued", 0, "排队中", stamp, stamp),
        )
    ensure_worker()
    jobs.put(task_id)
    return jsonify(ok=True, task_id=task_id), 202


@app.get("/api/tasks")
def list_tasks():
    with db() as conn:
        rows = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").fetchall()
    return jsonify(tasks=[task_dict(row) for row in rows], queued=jobs.qsize())


@app.post("/api/tasks/<task_id>/retry")
def retry_task(task_id: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            abort(404)
        conn.execute("UPDATE tasks SET status='queued',progress=0,stage='排队中',error=NULL,updated_at=? WHERE id=?", (now(), task_id))
    ensure_worker()
    jobs.put(task_id)
    return jsonify(ok=True)


@app.delete("/api/tasks/<task_id>")
def delete_task(task_id: str):
    with active_lock:
        with db() as conn:
            row = conn.execute("SELECT status FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                abort(404)
            if row["status"] == "running" or task_id in active_tasks:
                return jsonify(ok=False, error="任务正在运行，完成后再删除。"), 409
            conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    remove_task_media([task_id])
    return jsonify(ok=True)


@app.delete("/api/tasks")
def delete_all_tasks():
    with active_lock:
        with db() as conn:
            rows = conn.execute("SELECT id,status FROM tasks").fetchall()
            if any(row["status"] == "running" or row["id"] in active_tasks for row in rows):
                return jsonify(ok=False, error="有任务正在运行。请等它完成后再清空全部归档。"), 409
            ids = [row["id"] for row in rows]
            conn.execute("DELETE FROM tasks")
    remove_task_media(ids)
    return jsonify(ok=True, deleted=len(ids))


@app.get("/task/<task_id>")
def detail(task_id: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        abort(404)
    item = task_dict(row)
    if row["post_json"]:
        post = json.loads(row["post_json"])
        replies = json.loads(row["replies_json"] or "[]")
        ensure_legacy_media(task_id, post, replies)
        prepare_item_media(post, task_id)
        for reply in replies:
            prepare_item_media(reply, task_id)
        tree = build_tree(replies, row["post_id"])
    else:
        post, replies, tree = None, [], []
    return render_template("detail.html", task=item, post=post, replies=replies, tree=tree, offline=False, cover_data=None)


@app.get("/media/<task_id>/<path:filename>")
def media(task_id: str, filename: str):
    folder = (MEDIA_DIR / task_id).resolve()
    if folder.parent != MEDIA_DIR.resolve():
        abort(404)
    return send_from_directory(folder, filename)


@app.get("/cover/<task_id>")
def cover(task_id: str):
    with db() as conn:
        row = conn.execute("SELECT cover_file FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row or not row["cover_file"]:
        abort(404)
    return redirect(url_for("media", task_id=task_id, filename=row["cover_file"]))


@app.get("/export/<task_id>.json")
def export_json(task_id: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row or not row["post_json"]:
        abort(404)
    payload = {
        "source_url": row["url"],
        "saved_at": row["updated_at"],
        "status": row["status"],
        "expected_reply_count": row["reply_count"],
        "fetched_reply_count": row["fetched_count"],
        "post": json.loads(row["post_json"]),
        "replies": json.loads(row["replies_json"] or "[]"),
        "raw_api_pages": json.loads(row["raw_json"] or "[]"),
    }
    return app.response_class(json.dumps(payload, ensure_ascii=False, indent=2), mimetype="application/json")


@app.get("/export/<task_id>.html")
def export_html(task_id: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row or not row["post_json"]:
        abort(404)
    item = task_dict(row)
    post = json.loads(row["post_json"])
    replies = json.loads(row["replies_json"] or "[]")
    ensure_legacy_media(task_id, post, replies)
    prepare_item_media(post, task_id, offline=True)
    for reply in replies:
        prepare_item_media(reply, task_id, offline=True)
    tree = build_tree(replies, row["post_id"])
    cover_data = None
    if row["cover_file"]:
        cover_path = MEDIA_DIR / task_id / row["cover_file"]
        if cover_path.is_file():
            mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(cover_path.suffix.lower(), "application/octet-stream")
            cover_data = f"data:{mime};base64," + base64.b64encode(cover_path.read_bytes()).decode("ascii")
    page = render_template("detail.html", task=item, post=post, replies=replies, tree=tree, offline=True, cover_data=cover_data)
    response = make_response(page)
    response.headers["Content-Type"] = "text/html; charset=utf-8"
    response.headers["Content-Disposition"] = f'attachment; filename="x-thread-{row["post_id"]}.html"'
    return response


if __name__ == "__main__":
    init_db()
    load_persistent_settings()
    ensure_worker()
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
