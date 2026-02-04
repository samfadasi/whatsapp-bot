import express from "express";
import OpenAI from "openai";

// ================== ENV ==================
const PORT = process.env.PORT || 8080;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 450);

// ================== VALIDATION ==================
if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
}
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
}

// ================== CLIENTS ==================
const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ================== ROOT & HEALTH ==================
app.get("/", (req, res) => {
  res.send(`${BOT_NAME} running ✅`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ================== AI FUNCTION ==================
async function askAI(userText) {
  if (!openai) return null;

  const systemPrompt = `
You are QualiConsult AI.
You are a professional consultant specialized in:
- Quality Management
- Food Safety (HACCP)
- Occupational Health & Safety
- KPIs & Balanced Scorecard
- Lean & Continuous Improvement

Rules:
- Respond in Arabic by default unless user asks English
- Give practical, structured answers
- Use numbered steps, tables, and checklists when useful
- Be concise but complete
- No fluff, no emojis
  `.trim();

  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS
    });

    const text = response.output_text?.trim();
    return text || null;

  } catch (err) {
    console.error("❌ OpenAI error:", {
      status: err?.status,
      message: err?.message,
      code: err?.code,
      type: err?.type
    });
    return null;
  }
}

// ================== TELEGRAM WEBHOOK ==================
app.post("/telegram/webhook", async (req, res) => {
  // Telegram لازم ياخد 200 فوراً
  res.sendStatus(200);

  try {
    const update = req.body;
    console.log("📩 Telegram update:", JSON.stringify(update));

    const msg = update?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

    // /start or /help
    if (text === "/start" || text === "/help") {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text:
`مرحباً 👋 أنا ${BOT_NAME}.

اكتب سؤالك مباشرة في:
• الجودة
• سلامة الغذاء
• HACCP
• KPI
• التميز المؤسسي

أمثلة:
- كيف أطبق HACCP في مخبز صغير؟
- اعمل لي checklist مراجعة داخلية لقسم الجودة
- ابني KPI dashboard outline`
        })
      });
      return;
    }

    // ===== AI ANSWER =====
    const aiReply = await askAI(text);

    const finalReply = aiReply
      ? aiReply
      : "حدث خطأ في محرك الذكاء. جرّب تاني.";

    const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: finalReply
      })
    });

    const respText = await resp.text();
    console.log("📤 Telegram send:", resp.status, respText);

  } catch (e) {
    console.error("❌ Webhook handler error:", e);
  }
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
