import { describe, expect, it } from "vitest";
import { escapeHtml, findCursor, imageOriginalUrl, linkify, parseCookies, parsePostId, uploadStreamToR2, videoUrl } from "../src/index";

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

  it("uses the bottom timeline cursor instead of the top cursor", () => {
    expect(findCursor({ timeline: { instructions: [{ addEntries: { entries: [
      { content: { operation: { cursor: { cursorType: "Top", value: "top-cursor" } } } },
      { content: { operation: { cursor: { cursorType: "Bottom", value: "bottom-cursor" } } } },
    ] } }] } })).toBe("bottom-cursor");
  });

  it("requests the original image rendition even when X supplied a thumbnail URL", () => {
    expect(imageOriginalUrl("https://pbs.twimg.com/media/example.jpg?format=jpg&name=small"))
      .toBe("https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig");
  });

  it("uploads streams without Content-Length using bounded R2 multipart parts", async () => {
    const uploaded: Array<{ partNumber: number; bytes: number }> = [];
    let completed = false;
    let aborted = false;
    const multipart = {
      uploadPart: async (partNumber: number, value: ArrayBufferView) => {
        const part = { partNumber, etag: `etag-${partNumber}` };
        uploaded.push({ partNumber, bytes: value.byteLength });
        return part;
      },
      complete: async (parts: Array<{ partNumber: number }>) => { completed = parts.length === uploaded.length; },
      abort: async () => { aborted = true; },
    };
    const bucket = { createMultipartUpload: async () => multipart };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(7));
        controller.enqueue(new Uint8Array(13));
        controller.close();
      },
    });

    await uploadStreamToR2(bucket as never, "task/media.mp4", body, 0, 100, { contentType: "video/mp4" });

    expect(uploaded).toEqual([{ partNumber: 1, bytes: 20 }]);
    expect(completed).toBe(true);
    expect(aborted).toBe(false);
  });
});
