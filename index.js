import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : "";

app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Telegram Webhook (FINAL)
 * URL: https://YOUR_DOMAIN/telegram/webhook
 */
app.post("/telegram/webhook", async (req, res) => {
  // لازم نرد 200 بسرعة، تيليجرام حساس للتايم آوت
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    console.log("📩 Telegram update:", JSON.stringify(req.body));

    // لو ما في توكن، ما نكراش، بس نسجل
    if (!TELEGRAM_API) {
      console.log("⚠️ TELEGRAM_BOT_TOKEN missing");
      return;
    }

    // لو رسالة ما نصية
    if (!chatId || !text) return;

    // رد بسيط (تأكيد تشغيل) — بعدين بنبدله بـ AI + DB
    const reply =
      `مرحباً 👋\nأنا ${BOT_NAME}.\n\n` +
      `وصلت رسالتك:\n${text}\n\n` +
      `اكتب سؤالك في الجودة/سلامة الغذاء/HACCP/KPI وسأرد.`;

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    });
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
