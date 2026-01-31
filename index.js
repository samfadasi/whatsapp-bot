/**
 * QualiConsult AI — WhatsApp Cloud API + OpenAI Responses API (Railway-ready)
 * - Ultra-light (no axios / no openai SDK) -> stable memory
 * - Multi-part WhatsApp replies (no truncation)
 * - Dedup incoming messages (prevents double replies)
 * - Smart greeting behavior
 */

const express = require("express");
const https = require("https");

const app = express();
app.use(express.json());

/* ===== ENV (Railway Variables) ===== */
const PORT = process.env.PORT || 3000;

// WhatsApp (Meta)
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "qcai_2026").trim();
const META_ACCESS_TOKEN = (process.env.META_ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const GRAPH_API_VERSION = (process.env.GRAPH_API_VERSION || "v19.0").trim();
const TEST_TO = (process.env.TEST_TO || "").trim();

// OpenAI
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 500);

// Bot
const BOT_NAME = (process.env.BOT_NAME || "QualiConsult AI").trim();

// WhatsApp chunking
const WA_CHUNK_MAX = Number(process.env.WA_CHUNK_MAX || 2800);
const WA_SEND_DELAY_MS = Number(process.env.WA_SEND_DELAY_MS || 250);

console.log("=== ENV CHECK ===");
console.log("META:", META_ACCESS_TOKEN ? "OK" : "MISSING");
console.log("PHONE:", PHONE_NUMBER_ID ? "OK" : "MISSING");
console.log("OPENAI:", OPENAI_API_KEY ? "OK" : "MISSING");
console.log("MODEL:", OPENAI_MODEL);
console.log("MAX_OUTPUT_TOKENS:", MAX_OUTPUT_TOKENS);
console.log("=================");

/* ===== Helpers ===== */
function isArabic(text) {
  return /[\u0600-\u06FF]/.test(text || "");
}

function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "مرحبا" ||
    t === "مرحباً" ||
    t === "السلام عليكم" ||
    t === "سلام عليكم" ||
    t === "سلام" ||
    t === "هلا" ||
    t === "hi" ||
    t === "hello" ||
    t === "hey" ||
    t === "صباح الخير" ||
    t === "مساء الخير"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Dedup incoming messages (WhatsApp may resend)
 */
const seenMsgIds = new Map(); // id -> timestamp
function alreadySeen(msgId) {
  if (!msgId) return false;
  const now = Date.now();

  // cleanup older than 10 minutes
  for (const [k, v] of seenMsgIds.entries()) {
    if (now - v > 10 * 60 * 1000) seenMsgIds.delete(k);
  }

  if (seenMsgIds.has(msgId)) return true;
  seenMsgIds.set(msgId, now);
  return false;
}

/**
 * Minimal HTTPS JSON request helper
 */
function httpsJson({
  hostname,
  path,
  method = "GET",
  headers = {},
  bodyObj = null,
  timeoutMs = 25000,
}) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;

          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
          }

          if (status >= 200 && status < 300) resolve({ status, data: parsed });
          else {
            const err = new Error(`HTTP ${status}`);
            err.status = status;
            err.data = parsed;
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Split long text to multiple WhatsApp messages (no truncation)
 */
function splitIntoChunks(text, maxLen) {
  const t = String(text || "").trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];

  const chunks = [];
  let start = 0;

  while (start < t.length) {
    let end = Math.min(start + maxLen, t.length);

    // prefer newline cut for clean chunks
    const lastNl = t.lastIndexOf("\n", end);
    if (lastNl > start + 500) end = lastNl;

    chunks.push(t.slice(start, end).trim());
    start = end;
  }

  return chunks.filter(Boolean);
}

/* ===== WhatsApp Send ===== */
async function waSendText(to, body) {
  if (!META_ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp config (META_ACCESS_TOKEN / PHONE_NUMBER_ID)");
  }

  const parts = splitIntoChunks(body, WA_CHUNK_MAX);
  const path = `/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  for (let i = 0; i < parts.length; i++) {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: parts[i] },
    };

    await httpsJson({
      hostname: "graph.facebook.com",
      path,
      method: "POST",
      headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
      bodyObj: payload,
      timeoutMs: 15000,
    });

    if (i < parts.length - 1) await sleep(WA_SEND_DELAY_MS);
  }
}

/* ===== OpenAI Text Extraction ===== */
function extractOpenAIText(resp) {
  if (!resp || typeof resp !== "object") return "";

  if (typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  let out = "";
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (!item) continue;

      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (typeof part.text === "string" && part.text.trim()) out += part.text + "\n";
          else if (part.type === "output_text" && typeof part.text === "string") out += part.text + "\n";
        }
      }

      if (typeof item.text === "string" && item.text.trim()) out += item.text + "\n";
    }
  }

  return out.trim();
}

/* ===== Ask AI ===== */
async function askAI(userText) {
  if (!OPENAI_API_KEY) return "⚠️ OPENAI_API_KEY غير موجود في Variables.";

  const lang = isArabic(userText) ? "ar" : "en";

  const systemPromptAr = `
أنت ${BOT_NAME} مستشار صناعي في الجودة وسلامة الغذاء وHACCP وKPI والتميز المؤسسي.
القواعد:
- رد عملي تنفيذي: خطوات + ضوابط + سجلات + تحقق.
- واتساب: نقاط واضحة بدون إسهاب.
- إذا السؤال عام جداً: اسأل سؤال توضيحي واحد فقط.
`.trim();

  const systemPromptEn = `
You are ${BOT_NAME}, a practical consultant for Quality, Food Safety (HACCP), KPIs, and Excellence.
Rules:
- Actionable steps + controls + records + verification.
- WhatsApp-friendly bullets (no long essays).
- If too broad: ask ONE clarifying question only.
`.trim();

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: lang === "ar" ? systemPromptAr : systemPromptEn },
      { role: "user", content: String(userText || "") },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  try {
    const r = await httpsJson({
      hostname: "api.openai.com",
      path: "/v1/responses",
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      bodyObj: payload,
      timeoutMs: 30000,
    });

    const out = extractOpenAIText(r.data);
    return out || (lang === "ar" ? "❌ ما قدرت أطلع رد الآن. جرّب تاني." : "❌ Couldn't generate a reply. Try again.");
  } catch (e) {
    console.error("OpenAI error:", e.status, e.data || e.message);
    return "❌ خطأ في محرك الذكاء (راجع Logs).";
  }
}

/* ===== Routes ===== */
app.get("/", (_, res) => res.send(`${BOT_NAME} running ✅`));

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/test-send", async (_, res) => {
  try {
    if (!TEST_TO) return res.status(400).send("Set TEST_TO in Variables");
    await waSendText(TEST_TO, "🔥 Test message from QualiConsult AI");
    res.send("✅ Sent.");
  } catch (e) {
    console.error("test-send error:", e.status, e.data || e.message);
    res.status(500).send("❌ Send failed (check logs).");
  }
});

// Webhook verify
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Webhook receive
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    // Dedup
    if (alreadySeen(msg.id)) return;

    const from = msg.from;

    // Text only
    if (msg.type !== "text") {
      await waSendText(from, "حالياً بدعم الرسائل النصية فقط.");
      return;
    }

    const text = msg.text?.body || "";
    console.log("FROM:", from);
    console.log("TEXT:", text);

    // Greeting
    if (isGreeting(text)) {
      await waSendText(
        from,
        "مرحباً 👋\nأنا QualiConsult AI.\nاكتب سؤالك مباشرة في الجودة أو سلامة الغذاء أو HACCP أو KPI وسأرد بخطوات عملية مختصرة."
      );
      return;
    }

    const answer = await askAI(text);
    await waSendText(from, answer);
  } catch (e) {
    console.error("Webhook error:", e.status, e.data || e.message);
  }
});

/* ===== Start ===== */
app.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));
