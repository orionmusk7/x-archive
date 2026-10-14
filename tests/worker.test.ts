import { describe, expect, it } from "vitest";
import { escapeHtml, linkify, parseCookies, parsePostId, videoUrl } from "../src/index";

describe("Cloudflare worker input and rendering helpers", () => {
  it("accepts only supported X status links", () => {
    expect(parsePostId("https://x.com/user/status/123?s=20")).toBe("123");
    expect(parsePostId("https://twitter.com/user/status/456")).toBe("456");
    expect(parsePostId("https://example.com/user/status/456")).toBeNull();
    expect(parsePostId("https://x.com.evil.test/user/status/456")).toBeNull();
  });

  it("parses supported cookie formats and requires auth cookies", () => {
    expect(parseCookies('[{"name":"auth_token","value":"secret"},{"name":"ct0","value":"csrf"}]'))
      .toEqual({ auth_token: "secret", ct0: "csrf" });
    expect(parseCookies("auth_token=secret; ct0=csrf").ct0).toBe("csrf");
    expect(() => parseCookies("foo=bar")).toThrow(/auth_token/);
    expect(() => parseCookies("auth_token=bad;ct0=x\r\nInjected=yes")).toThrow(/invalid|Cookie/i);
  });

  it("escapes untrusted text and only linkifies safe displayed URLs", () => {
    expect(escapeHtml('<script>alert("x")</script>')).not.toContain("<script>");
    expect(linkify("Hi 🤤 @person https://example.com/?x=1&y=2 <script>"))
      .toContain("@person");
    expect(linkify("https://example.com/?x=1&y=2")).toContain("&amp;y=2");
  });

  it("selects highest-bitrate HTTPS mp4 variant from twimg only", () => {
    expect(videoUrl({ video_info: { variants: [
      { content_type: "video/mp4", bitrate: 300, url: "https://video.twimg.com/low.mp4" },
      { content_type: "application/x-mpegURL", url: "https://video.twimg.com/playlist.m3u8" },
      { content_type: "video/mp4", bitrate: 800, url: "https://video.twimg.com/high.mp4" },
    ] } })).toBe("https://video.twimg.com/high.mp4");
    expect(videoUrl({ video_info: { variants: [
      { content_type: "video/mp4", bitrate: 1, url: "https://evil.example/video.mp4" },
    ] } })).toBeNull();
  });
});
