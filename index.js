import express from "express";

// ===== Basic App Setup =====
const app = express();
app.use(express.json());

// ===== Environment =====
const PORT = process.env.PORT || 8080;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ===== Safety Check =====
if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is missing");
}

// ===== Telegram API Base =====
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ===== Root =====
app.get("/", (req, res) => {
  res.send(`${BOT_NAME} running ✅`);
});

// ===== Health =====
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ===== Telegram Webhook =====
// URL: https://YOUR_DOMAIN/telegram/webhook
app.post("/telegram/webhook", async (req, res) => {
  // Telegram requires 200 immediately
  res.sendStatus(200);

  try {
    console.log("📩 Telegram update:", JSON.stringify(req.body));

    const message = req.body?.message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = message.text?.trim();

    if (!chatId || !text) return;

    const replyText =
      `مرحباً 👋\n` +
      `أنا ${BOT_NAME}.\n\n` +
      `وصلت رسالتك:\n"${text}"\n\n` +
      `اكتب سؤالك في:\n` +
      `• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\nوسأرد بخطوات عملية مختصرة.`;

    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
      }),
    });

    const resultText = await response.text();
    console.log("📤 Telegram send response:", response.status, resultText);
  } catch (error) {
    console.error("❌ Telegram webhook error:", error);
  }
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
