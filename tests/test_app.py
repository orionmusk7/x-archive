import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import app


class AppHelpersTest(unittest.TestCase):
    def test_parse_post_id(self):
        self.assertEqual(app.parse_post_id("https://x.com/name/status/123?s=20"), "123")
        self.assertEqual(app.parse_post_id("https://twitter.com/name/status/456"), "456")
        self.assertIsNone(app.parse_post_id("https://example.com/name/status/456"))

    def test_parse_cookie_json_and_header(self):
        exported = json.dumps([
            {"name": "auth_token", "value": "secret"},
            {"name": "ct0", "value": "csrf"},
        ])
        self.assertEqual(app.parse_cookie_input(exported)["ct0"], "csrf")
        self.assertEqual(app.parse_cookie_input("auth_token=secret; ct0=csrf")["auth_token"], "secret")

    def test_linkify_keeps_unicode_and_escapes_markup(self):
        rendered = str(app.linkify("wow 🤤 @person https://example.com/a?x=1&y=2 <script>"))
        self.assertIn("wow 🤤", rendered)
        self.assertIn("@person", rendered)
        self.assertIn("&amp;", rendered)
        self.assertNotIn("<script>", rendered)

    def test_build_tree_preserves_parent_reply(self):
        rows = [
            {"id": "a", "parent_id": "post", "children": []},
            {"id": "b", "parent_id": "a", "children": []},
        ]
        tree = app.build_tree(rows, "post")
        self.assertEqual(tree[0]["id"], "a")
        self.assertEqual(tree[0]["children"][0]["id"], "b")

    def test_validate_proxy(self):
        self.assertEqual(app.validate_proxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890")
        self.assertEqual(app.validate_proxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080")
        self.assertEqual(app.validate_proxy("socks5h://127.0.0.1:1080"), "socks5h://127.0.0.1:1080")
        self.assertEqual(app.validate_proxy(""), "")
        with self.assertRaises(ValueError):
            app.validate_proxy("127.0.0.1:7890")

    def test_video_media_uses_extended_entities_and_highest_bitrate_file(self):
        original_media_dir = app.MEDIA_DIR
        tweet = {
            "entities": {"media": [{"type": "photo", "media_url_https": "https://example.test/thumb.jpg"}]},
            "extended_entities": {"media": [{
                "type": "video",
                "media_url_https": "https://example.test/poster.jpg",
                "video_info": {"variants": [
                    {"content_type": "video/mp4", "bitrate": 400, "url": "https://example.test/low.mp4"},
                    {"content_type": "application/x-mpegURL", "url": "https://example.test/playlist.m3u8"},
                    {"content_type": "video/mp4", "bitrate": 1200, "url": "https://example.test/high.mp4"},
                ]},
            }]},
        }
        try:
            with tempfile.TemporaryDirectory() as temp:
                app.MEDIA_DIR = Path(temp)
                downloaded = []

                def fake_download(url, path, configured_proxy=""):
                    downloaded.append(url)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"asset")

                with patch.object(app, "download_media_file", side_effect=fake_download):
                    attachments, cover = app.save_tweet_media("0123456789ab", tweet, "123")

                self.assertEqual(attachments[0]["type"], "video")
                self.assertTrue(attachments[0]["file"].endswith(".mp4"))
                self.assertEqual(cover, attachments[0]["poster_file"])
                self.assertIn("https://example.test/high.mp4", downloaded)
                self.assertNotIn("https://example.test/thumb.jpg", downloaded)
                self.assertTrue((Path(temp) / "0123456789ab" / attachments[0]["file"]).is_file())
        finally:
            app.MEDIA_DIR = original_media_dir

    def test_video_remains_available_when_optional_poster_download_fails(self):
        original_media_dir = app.MEDIA_DIR
        tweet = {"extended_entities": {"media": [{
            "type": "video",
            "media_url_https": "https://example.test/poster.jpg",
            "video_info": {"variants": [{"content_type": "video/mp4", "bitrate": 100, "url": "https://example.test/video.mp4"}]},
        }]}}
        try:
            with tempfile.TemporaryDirectory() as temp:
                app.MEDIA_DIR = Path(temp)

                def fake_download(url, path, configured_proxy=""):
                    if url.endswith("poster.jpg"):
                        raise RuntimeError("poster unavailable")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"video")

                with patch.object(app, "download_media_file", side_effect=fake_download):
                    attachments, _ = app.save_tweet_media("0123456789ab", tweet, "123")

                self.assertNotIn("error", attachments[0])
                self.assertEqual(attachments[0]["type"], "video")
                self.assertIsNotNone(attachments[0].get("file"))
                self.assertIn("poster_error", attachments[0])
        finally:
            app.MEDIA_DIR = original_media_dir

    def test_persistent_settings_are_encrypted_and_portable_files_roundtrip(self):
        original_paths = app.SESSION_PATH, app.SESSION_KEY_PATH
        old_state = dict(app.session_cookies), app.proxy_url, app.session_persistent
        try:
            with tempfile.TemporaryDirectory() as temp:
                app.SESSION_PATH = Path(temp) / "session.enc"
                app.SESSION_KEY_PATH = Path(temp) / "session.key"
                app.session_cookies.clear()
                app.session_cookies.update({"auth_token": "test-auth-secret", "ct0": "test-csrf-secret"})
                app.proxy_url = "socks5h://127.0.0.1:1080"
                app.session_persistent = True
                app.save_persistent_settings()
                encrypted = app.SESSION_PATH.read_bytes()
                self.assertNotIn(b"test-auth-secret", encrypted)
                self.assertNotIn(b"test-csrf-secret", encrypted)

                app.session_cookies.clear()
                app.proxy_url = ""
                app.session_persistent = False
                app.load_persistent_settings()
                self.assertEqual(app.session_cookies["auth_token"], "test-auth-secret")
                self.assertEqual(app.proxy_url, "socks5h://127.0.0.1:1080")
                self.assertTrue(app.session_persistent)
        finally:
            app.SESSION_PATH, app.SESSION_KEY_PATH = original_paths
            app.session_cookies.clear()
            app.session_cookies.update(old_state[0])
            app.proxy_url, app.session_persistent = old_state[1:]


class DeleteRoutesTest(unittest.TestCase):
    def setUp(self):
        self.original_db_path = app.DB_PATH
        self.temp_dir = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        app.init_db()
        self.client = app.app.test_client()
        self.ids = [uuid.uuid4().hex[:12], uuid.uuid4().hex[:12]]
        with app.db() as conn:
            for index, task_id in enumerate(self.ids):
                conn.execute(
                    "INSERT INTO tasks(id,url,post_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                    (task_id, f"https://x.com/user/status/{index}", str(index), "saved", app.now(), app.now()),
                )

    def tearDown(self):
        app.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def test_single_and_bulk_delete_are_separate(self):
        response = self.client.delete(f"/api/tasks/{self.ids[0]}")
        self.assertEqual(response.status_code, 200)
        with app.db() as conn:
            remaining = conn.execute("SELECT id FROM tasks").fetchall()
        self.assertEqual([row["id"] for row in remaining], [self.ids[1]])

        response = self.client.delete("/api/tasks")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["deleted"], 1)
        with app.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_bulk_delete_refuses_while_task_running(self):
        with app.db() as conn:
            conn.execute("UPDATE tasks SET status='running' WHERE id=?", (self.ids[0],))
        response = self.client.delete("/api/tasks")
        self.assertEqual(response.status_code, 409)
        with app.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
