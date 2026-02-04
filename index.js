import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 450);

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true, ai: !!openai, model: OPENAI_MODEL }));

async function sendTelegram(chatId, text) {
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await r.text();
  console.log("📤 sendMessage:", r.status, body);
}

async function askAI(userText) {
  if (!openai) return null;

  const system = `
You are QualiConsult AI, a practical consultant specialized in:
Quality Management, Food Safety (HACCP), OHS, KPI/BSC, Lean.
Write in Arabic by default (unless user asks English).
Be concise but complete. Use numbered steps + checklists when useful.
Avoid long intros. No fluff.
`;

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system.trim() },
      { role: "user", content: userText },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  });

  // Extract text safely
  const out = resp.output_text?.trim();
  return out || null;
}

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

    console.log("📩 Telegram:", JSON.stringify({ chatId, text }));

    // Commands
    if (text === "/start" || text === "/help") {
      await sendTelegram(
        chatId,
        `مرحباً 👋 أنا ${BOT_NAME}.\n\nاكتب سؤالك مباشرة في:\n• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي\n\nمثال:\nكيف أطبق HACCP في مخبز صغير؟`
      );
      return;
    }

    // AI
    const answer = await askAI(text);
    if (answer) {
      await sendTelegram(chatId, answer);
      return;
    }

    // Fallback
    await sendTelegram(chatId, "حدث خطأ في محرك الذكاء. جرّب تاني.");
  } catch (e) {
    console.error("❌ webhook error:", e);
    // best-effort: no crash
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
