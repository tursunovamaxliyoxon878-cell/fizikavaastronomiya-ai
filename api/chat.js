// Vercel serverless function.
// GEMINI_API_KEY and FIREBASE_API_KEY must be set in Vercel Environment Variables.
// For reliable rate limiting across serverless instances, also set:
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.

// Gemini 2.5 models may return 404 for newly created API projects.
// Prefer current models; GEMINI_MODEL can override the default in Vercel.
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
].filter((value, index, all) => value && all.indexOf(value) === index);

const RATE_LIMIT = 30;
const WINDOW_SECONDS = 60 * 60;

// Best-effort fallback only. This Map is not shared between Vercel instances.
const localHits = new Map();

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function verifyFirebaseToken(token) {
  if (!process.env.FIREBASE_API_KEY) {
    throw new Error("FIREBASE_API_KEY sozlanmagan");
  }

  const response = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
      encodeURIComponent(process.env.FIREBASE_API_KEY),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    }
  );

  if (!response.ok) return null;

  const data = await response.json();
  const user = data.users && data.users[0];

  // Firebase verifies the ID token and returns the corresponding account.
  return user && user.localId ? user.localId : null;
}

async function checkRateLimit(uid) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    // Atomic fixed-window counter in Redis.
    const key = "chat-rate:" + uid + ":" + Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const script =
      "local n = redis.call('INCR', KEYS[1]); " +
      "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; " +
      "return n";

    const response = await fetch(redisUrl.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + redisToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(["EVAL", script, "1", key, String(WINDOW_SECONDS)]),
    });

    if (!response.ok) throw new Error("Rate-limit xizmati ishlamadi");

    const result = await response.json();
    if (result.error) throw new Error("Rate-limit xizmati xatosi");
    return Number(result.result) <= RATE_LIMIT;
  }

  // Fallback for testing. Configure Upstash Redis for production.
  const now = Date.now();
  const recent = (localHits.get(uid) || []).filter(
    (timestamp) => now - timestamp < WINDOW_SECONDS * 1000
  );

  if (recent.length >= RATE_LIMIT) {
    localHits.set(uid, recent);
    return false;
  }

  recent.push(now);
  localHits.set(uid, recent);
  return true;
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];

  return input
    .slice(-12)
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0
    )
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content.slice(0, 12000) }],
    }));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Faqat POST so‘rovi ruxsat etilgan");
  }

  if (!process.env.GEMINI_API_KEY) {
    return sendError(res, 500, "Serverda Gemini API kaliti sozlanmagan");
  }

  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match && match[1].trim();

  if (!token) {
    return sendError(res, 401, "Kirish talab qilinadi");
  }

  let uid;
  try {
    uid = await verifyFirebaseToken(token);
  } catch (error) {
    console.error("Firebase token tekshirish xatosi:", error.message);
    return sendError(res, 503, "Kirish xizmatida vaqtinchalik xatolik");
  }

  if (!uid) {
    return sendError(res, 401, "Kirish tokeni yaroqsiz yoki muddati tugagan");
  }

  let allowed;
  try {
    allowed = await checkRateLimit(uid);
  } catch (error) {
    console.error("Rate-limit xatosi:", error.message);
    return sendError(res, 503, "So‘rovlar limitini tekshirish imkoni bo‘lmadi");
  }

  if (!allowed) {
    return sendError(res, 429, "Soatlik limit tugadi. Keyinroq urinib ko‘ring.");
  }

  const messages = cleanMessages(req.body && req.body.messages);
  if (!messages.length) {
    return sendError(res, 400, "Yuborish uchun to‘g‘ri xabar topilmadi");
  }

  const requestBody = {
    contents: messages,
    generationConfig: { maxOutputTokens: 2500 },
  };

  if (req.body && req.body.web === true) {
    requestBody.tools = [{ google_search: {} }];
  }

  let upstream = null;

  for (const model of MODEL_CANDIDATES) {
    try {
      upstream = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) +
          ":streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify(requestBody),
        }
      );
    } catch (error) {
      console.error("Gemini bilan ulanish xatosi:", error.message);
      return sendError(res, 502, "Gemini xizmatiga ulanib bo‘lmadi");
    }

    // Try the next model only for missing-model or quota responses.
    if (upstream.ok || (upstream.status !== 404 && upstream.status !== 429)) {
      break;
    }
  }

  if (!upstream || !upstream.ok) {
    const status = upstream ? upstream.status : 502;

    if (status === 429) {
      return sendError(res, 429, "Gemini API limiti tugadi. Keyinroq urinib ko‘ring.");
    }

    const detail = upstream ? await upstream.text() : "";
    console.error("Gemini API xatosi:", status, detail.slice(0, 500));
    return sendError(res, 502, "Gemini API so‘rovni bajara olmadi");
  }

  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-content-type-options", "nosniff");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const data = JSON.parse(raw);
          const parts =
            data.candidates &&
            data.candidates[0] &&
            data.candidates[0].content &&
            data.candidates[0].content.parts
              ? data.candidates[0].content.parts
              : [];

          for (const part of parts) {
            if (typeof part.text === "string" && !part.thought) {
              res.write(
                "data: " +
                  JSON.stringify({
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: part.text },
                  }) +
                  "\n\n"
              );
            }
          }
        } catch (error) {
          // Ignore malformed or non-JSON SSE lines.
        }
      }
    }
  } catch (error) {
    console.error("Gemini oqimini o‘qish xatosi:", error.message);
    if (!res.headersSent) {
      return sendError(res, 502, "Gemini javobini olishda xatolik");
    }
  }

  return res.end();
};
