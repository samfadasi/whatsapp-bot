import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

// ===== Guards =====
if (!TELEGRAM_BOT_TOKEN) console.error("❌ TELEGRAM_BOT_TOKEN missing");
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY missing");

// Telegram constants
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TG_MAX = 3900; // Telegram limit 4096; keep margin

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== Helpers =====
function clip(text, max = TG_MAX) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 20) + "\n\n(تم تقصير الرد…)" : text;
}

function isCommand(t) {
  return typeof t === "string" && t.startsWith("/");
}

function helpText() {
  return (
    `مرحباً 👋 أنا ${BOT_NAME}.\n\n` +
    `اكتب سؤالك مباشرة في:\n` +
    `• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي\n\n` +
    `أمثلة:\n` +
    `- كيف أطبق HACCP في مخبز صغير؟\n` +
    `- اعمل لي checklist مراجعة داخلية لقسم الجودة في مخبز\n` +
    `- ابني KPI dashboard outline لقسم الجودة\n`
  );
}

async function askAI(userText) {
  // System prompt مضبوط لشغلك: عملي، مختصر، أسئلة قليلة عند الضرورة
  const system = `
أنت مستشار تقني متخصص في:
- الجودة (QMS) وسلامة الغذاء (FSMS / HACCP / ISO 22000)
- التميز المؤسسي
- مؤشرات قياس الأداء KPI/BSC
- التحسين المستمر/Lean
أسلوبك: عملي، مباشر، خطوات قابلة للتطبيق، بدون حشو.
إذا السؤال عام: قدّم إطار عمل + أمثلة جاهزة.
إذا تحتاج معلومة واحدة حاسمة (نوع المنتج/درجة التخزين/حجم المنشأة): اسأل سؤال واحد فقط.
اكتب بالعربية الفصحى المبسطة. استخدم نقاط وترقيم. لا تتجاوز 12 نقطة في الرد إلا للضرورة.
`.trim();

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    // ملاحظة: لا نضع temperature ولا max_tokens لتفادي أخطاء النماذج
    max_output_tokens: 420,
    input: [
      { role: "system", content: system },
      { role: "user", content: userText }
    ]
  });

  // استخراج النص من response (يدعم عدة أشكال)
  const out =
    (resp.output_text && resp.output_text.trim()) ||
    (resp.output?.[0]?.content?.[0]?.text?.trim?.() ?? "");

  return out || "ما قدرت أطلع رد الآن. جرّب تاني.";
}

async function sendTelegramMessage(chatId, text) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text: clip(text) };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const t = await r.text();
  console.log("📤 Telegram send response:", r.status, t);
  return r.ok;
}

// ===== Routes =====
app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true }));

// Telegram Webhook
// URL: https://YOUR_DOMAIN/telegram/webhook
app.post("/telegram/webhook", async (req, res) => {
  // Telegram لازم 200 فوراً
  res.sendStatus(200);

  try {
    console.log("📩 Telegram update:", JSON.stringify(req.body));

    if (!TELEGRAM_BOT_TOKEN) return;
    if (!OPENAI_API_KEY) {
      const msg = req.body?.message;
      const chatId = msg?.chat?.id;
      if (chatId) await sendTelegramMessage(chatId, "❌ OPENAI_API_KEY غير موجود في المتغيرات.");
      return;
    }

    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

    // Commands
    if (isCommand(text)) {
      if (text === "/start" || text === "/help") {
        await sendTelegramMessage(chatId, helpText());
        return;
      }
      await sendTelegramMessage(chatId, "استخدم /help لعرض طريقة الاستخدام.");
      return;
    }

    // AI answer
    const answer = await askAI(text);
    await sendTelegramMessage(chatId, answer);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await sendTelegramMessage(chatId, "حدث خطأ في محرك الذكاء. جرّب تاني.");
    } catch {}
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("MODEL:", OPENAI_MODEL);
});
