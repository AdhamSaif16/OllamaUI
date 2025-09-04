// app/api/chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";

/** ---------- helpers ---------- **/
function guessExtFromContentType(ct?: string | null) {
  if (!ct) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("jpeg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  return "jpg";
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } {
  const match = /^data:(.+?);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new Error("Unsupported data URL format.");
  const contentType = match[1];
  const base64 = match[2];
  return { buffer: Buffer.from(base64, "base64"), contentType };
}

async function fetchAsBuffer(url: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = res.headers.get("content-type");
  return { buffer, contentType };
}

/**
 * Decide the folder id for this chat.
 * - If cookie "chatFolderId" exists → reuse (ongoing chat).
 * - Else → create new folder name: YYYY-MM-DD-<short-random>, store in cookie.
 */
function resolveChatFolderId() {
  const jar = cookies();
  const existing = jar.get("chatFolderId")?.value;
  if (existing) {
    return { chatId: existing, setCookieHeader: undefined };
  }

  const today = new Date().toISOString().split("T")[0]; // e.g. 2025-09-04
  const shortRand = randomUUID().split("-")[0];         // take first block of uuid
  const folder = `${today}-${shortRand}`;

  const maxAge = 60 * 60 * 24 * 90; // 90 days
  const setCookie = `chatFolderId=${folder}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  return { chatId: folder, setCookieHeader: setCookie };
}

/** ---------- S3/YOLO setup ---------- **/
const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.AWS_S3_BUCKET!;
const YOLO = process.env.YOLO_SERVICE!;

export async function POST(req: Request) {
  const { messages = [], selectedModel, data = {} } = await req.json();

  const { chatId, setCookieHeader } = resolveChatFolderId();

  let message = "Please provide an image for object detection.";

  if (data?.images && data.images.length > 0) {
    try {
      const imageUrl = data.images[0] as string;

      let buffer: Buffer;
      let contentType: string | null = null;

      if (imageUrl.startsWith("data:")) {
        const parsed = parseDataUrl(imageUrl);
        buffer = parsed.buffer;
        contentType = parsed.contentType;
      } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
        const fetched = await fetchAsBuffer(imageUrl);
        buffer = fetched.buffer;
        contentType = fetched.contentType;
      } else {
        throw new Error("Unsupported image source. Use a data URL or http(s) URL.");
      }

      // upload to S3 under <chatId>/original/<timestamp>.<ext>
      const ext = guessExtFromContentType(contentType);
      const ts = Date.now();
      const key = `${chatId}/original/${ts}.${ext}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType || "image/jpeg",
        })
      );

      // call YOLO with that key + chat_id
      const yoloUrl = `http://${YOLO}/predict?img=${encodeURIComponent(
        key
      )}&chat_id=${encodeURIComponent(chatId)}`;
      const predictionResponse = await fetch(yoloUrl, { method: "POST" });

      if (!predictionResponse.ok) {
        const text = await predictionResponse.text().catch(() => "");
        throw new Error(`Prediction API error: ${predictionResponse.status} ${text}`);
      }

      const predictionResult = await predictionResponse.json();

      message = `🔍 **Object Detection Results**

**Detection Count:** ${predictionResult.detection_count}
**Detected Objects:** ${predictionResult.labels.join(", ")}
**Prediction ID:** ${predictionResult.prediction_uid}

I've analyzed your image and detected ${predictionResult.detection_count} object(s). The detected objects include: ${predictionResult.labels.join(", ")}.`;
    } catch (error) {
      console.error("Object detection error:", error);
      message = `❌ **Object Detection Error**

Sorry, I encountered an error while processing your image: ${
        error instanceof Error ? error.message : "Unknown error"
      }

Please make sure the object detection service is reachable at http://${process.env.YOLO_SERVICE}.`;
    }
  }

  // stream back
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const lines = message.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const content = i < lines.length - 1 ? line + "\n" : line;
        controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
      }
      controller.enqueue(
        encoder.encode(
          `e:${JSON.stringify({
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: message.length },
            isContinued: false,
          })}\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `d:${JSON.stringify({
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: message.length },
          })}\n`
        )
      );
      controller.close();
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Vercel-AI-Data-Stream": "v1",
  };
  if (setCookieHeader) headers["Set-Cookie"] = setCookieHeader;

  return new Response(stream, { headers });
}
