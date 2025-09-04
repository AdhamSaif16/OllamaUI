// app/api/chat/route.ts
//export const runtime = "nodejs";              // switched from "edge" to use AWS SDK
export const dynamic = "force-dynamic";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/** Helpers **/
function guessExtFromContentType(ct?: string | null) {
  if (!ct) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("jpeg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  return "jpg";
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } {
  // data:[<mediatype>][;base64],<data>
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

function getChatId(data: any, messages: any[]): string {
  // Prefer explicit chat id if you pass it from your UI
  return (
    data?.chatId ||
    data?.chat_id ||
    messages?.[0]?.id ||
    "anonymous"
  ).toString();
}


/** S3 client (uses env + instance role or env creds) **/
const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

const BUCKET = process.env.AWS_S3_BUCKET!;
const YOLO = process.env.YOLO_SERVICE!; // e.g. "yolo:8080" (docker) or "localhost:8080" (local)

export async function POST(req: Request) {
  const { messages, selectedModel, data } = await req.json();

  // Remove experimental_attachments (kept from your original code)
  const cleanedMessages = (messages || []).map((message: any) => {
    const { experimental_attachments, ...cleanMessage } = message ?? {};
    return cleanMessage;
  });

  let message = "Please provide an image for object detection.";

  if (data?.images && data.images.length > 0) {
    try {
      const imageUrl = data.images[0] as string;
      const chatId = getChatId(data, messages);
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

      const ext = guessExtFromContentType(contentType);
      const ts = Date.now();
      const key = `${chatId}/original/${ts}.${ext}`;

      // Upload original image to S3
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType || "image/jpeg",
      }));

      // Call YOLO with the S3 key (no body needed; YOLO downloads from S3)
      const yoloUrl = `http://${YOLO}/predict?img=${encodeURIComponent(key)}&chat_id=${encodeURIComponent(chatId)}`;
      const predictionResponse = await fetch(yoloUrl, { method: "POST" });

      if (!predictionResponse.ok) {
        const text = await predictionResponse.text().catch(() => "");
        throw new Error(`Prediction API error: ${predictionResponse.status} ${text}`);
      }

      const predictionResult = await predictionResponse.json();

      // Build chat message (same style you had)
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

  // Stream back (unchanged from your original approach)
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
          })}\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `d:${JSON.stringify({
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: message.length },
          })}\n`,
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Vercel-AI-Data-Stream": "v1",
    },
  });
}
