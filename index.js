import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_NAME = "QualiConsult AI";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();
    if (!chatId || !text) return;

    const reply =
      text === "/start" || text === "/help"
        ? `مرحباً 👋 أنا ${BOT_NAME}.\n\nاكتب سؤالك في الجودة/سلامة الغذاء/HACCP/KPI.\n\nمثال:\n- كيف أطبق HACCP في مخبز صغير؟`
        : `وصلت رسالتك:\n"${text}"\n\n✅ البوت شغال.\n🧠 الذكاء بنفعّلو بعد ما نثبت الاستقرار.`;

    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });

    const body = await r.text();
    console.log("📤 sendMessage:", r.status, body);
  } catch (e) {
    console.error("❌ webhook error:", e);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
