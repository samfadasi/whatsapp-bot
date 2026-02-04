import express from "express";
import OpenAI from "openai";
import pg from "pg";

const { Pool } = pg;

// ========= ENV =========
const PORT = process.env.PORT || 8080;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 950);
const MEMORY_TURNS = Number(process.env.MEMORY_TURNS || 12);

const DATABASE_URL = process.env.DATABASE_URL || "";

// ========= VALIDATION =========
if (!TELEGRAM_BOT_TOKEN) console.error("❌ TELEGRAM_BOT_TOKEN missing");
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY missing");
if (!DATABASE_URL) console.error("❌ DATABASE_URL missing");

// ========= CLIENTS =========
const app = express();
app.use(express.json());

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Railway Postgres غالباً يحتاج SSL
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// ========= HELPERS =========
function chunkText(text, maxLen = 3500) {
  const chunks = [];
  let s = text || "";
  while (s.length > maxLen) {
    // حاول تقطع على سطر
    let cut = s.lastIndexOf("\n", maxLen);
    if (cut < 800) cut = maxLen; // لو ما لقينا سطر كويس
    chunks.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s.trim().length) chunks.push(s);
  return chunks;
}

async function sendTelegram(chatId, text) {
  const parts = chunkText(text, 3500);
  for (const part of parts) {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part }),
    });
    const body = await r.text();
    console.log("📤 sendMessage:", r.status, body);
  }
}

async function dbEnsureSession(chatId) {
  if (!pool) return;
  await pool.query(
    `insert into sessions(chat_id, updated_at)
     values ($1, now())
     on conflict (chat_id) do update set updated_at = now()`,
    [chatId]
  );
}

async function dbAddMessage(chatId, role, content) {
  if (!pool) return;
  await pool.query(
    `insert into messages(chat_id, role, content) values ($1, $2, $3)`,
    [chatId, role, content]
  );
}

async function dbGetRecentMessages(chatId, limit = 12) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `select role, content
     from messages
     where chat_id = $1
     order by created_at desc
     limit $2`,
    [chatId, limit]
  );
  // رجّعها من الأقدم للأحدث
  return rows.reverse();
}

async function dbClearChat(chatId) {
  if (!pool) return;
  await pool.query(`delete from messages where chat_id = $1`, [chatId]);
}

// ========= AI =========
async function askAIWithMemory(chatId, userText) {
  if (!openai) return null;

  const systemPrompt = `
You are QualiConsult AI.
A practical consultant specialized in:
- Quality Management
- Food Safety (HACCP)
- Occupational Health & Safety
- KPIs & Balanced Scorecard
- Lean & Continuous Improvement

Rules:
- Arabic by default (English only if user asks)
- Keep the answer practical, structured, and usable
- Use steps, checklists, tables when helpful
- If the user asks for templates/forms, produce clean template text ready to paste into Excel/Word
- Remember context from the conversation and do not re-ask already provided info unless missing
- No fluff
  `.trim();

  const history = await dbGetRecentMessages(chatId, MEMORY_TURNS);

  const input = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  try {
    const resp = await openai.responses.create({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    const out = resp.output_text?.trim();
    return out || null;
  } catch (err) {
    console.error("❌ OpenAI error:", {
      status: err?.status,
      message: err?.message,
      code: err?.code,
      type: err?.type,
    });
    return null;
  }
}

// ========= ROUTES =========
app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

    console.log("📩 Telegram:", JSON.stringify({ chatId, text }));

    // DB session touch
    await dbEnsureSession(chatId);

    // Commands
    if (text === "/start" || text === "/help") {
      await sendTelegram(
        chatId,
        `مرحباً 👋 أنا ${BOT_NAME}.\n\nاكتب سؤالك مباشرة في:\n• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي\n• السلامة والصحة المهنية\n• Lean\n\nأوامر:\n/help\n/reset (يمسح ذاكرة المحادثة)\n\nمثال:\nكيف أطبق HACCP في مخبز صغير؟`
      );
      return;
    }

    if (text === "/reset") {
      await dbClearChat(chatId);
      await sendTelegram(chatId, "✅ تم مسح سياق المحادثة. ارسل سؤالك من جديد.");
      return;
    }

    // Save user message
    await dbAddMessage(chatId, "user", text);

    // Ask AI (with memory)
    const answer = await askAIWithMemory(chatId, text);

    if (!answer) {
      await sendTelegram(chatId, "حدث خطأ في محرك الذكاء. جرّب تاني.");
      return;
    }

    // Save assistant message
    await dbAddMessage(chatId, "assistant", answer);

    // Reply
    await sendTelegram(chatId, answer);
  } catch (e) {
    console.error("❌ Webhook handler error:", e);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
