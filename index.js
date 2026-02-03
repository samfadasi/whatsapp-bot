import express from "express";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* =====================
   Basic setup
===================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

if (!TELEGRAM_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN missing");
}
if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY missing");
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =====================
   Helpers
===================== */

// Telegram max message ≈ 4096 chars
function splitTelegram(text, limit = 3500) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + line).length > limit) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function sendTelegram(chatId, text) {
  const parts = splitTelegram(text);
  for (const part of parts) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: part
      })
    });
  }
}

/* =====================
   AI logic
===================== */
async function askAI(userText) {
  // Retry once فقط
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.responses.create({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content:
              "You are a senior technical consultant in Quality, Food Safety, HACCP, KPI, and Operational Excellence. " +
              "Respond in clear Arabic primarily, with concise professional structure. " +
              "If the answer is long, continue automatically without asking the user to say 'continue'."
          },
          {
            role: "user",
            content: userText
          }
        ],
        max_output_tokens: 1200
      });

      const output =
        response.output_text ||
        response.output?.[0]?.content?.[0]?.text ||
        "";

      return output || "لم أتمكن من توليد رد مفيد حالياً.";
    } catch (err) {
      console.error(`❌ AI attempt ${attempt} failed:`, err?.message || err);
      if (attempt === 2) throw err;
    }
  }
}

/* =====================
   Excel generation
===================== */
async function generateExcelChecklist() {
  const workbook = new ExcelJS.Workbook();

  /* Sheet 1: Internal Audit Checklist */
  const sheet1 = workbook.addWorksheet("Internal Audit Checklist");

  sheet1.columns = [
    { header: "No", key: "no", width: 6 },
    { header: "البند (AR)", key: "ar", width: 40 },
    { header: "Item (EN)", key: "en", width: 40 },
    { header: "Compliance (Yes/No)", key: "comp", width: 20 },
    { header: "Notes", key: "notes", width: 30 }
  ];

  const checklist = [
    ["وجود دليل جودة محدث", "Updated quality manual available"],
    ["إجراءات تشغيل معتمدة (SOPs)", "Approved SOPs available"],
    ["سجلات تدريب العاملين", "Training records maintained"],
    ["فحص واستلام المواد الخام", "Raw material inspection"],
    ["مراقبة درجات الحرارة", "Temperature monitoring"],
    ["نظافة وتعقيم المعدات", "Cleaning & sanitation program"],
    ["فحص المنتج النهائي", "Final product inspection"],
    ["إدارة المنتجات غير المطابقة", "Nonconforming product control"]
  ];

  checklist.forEach((item, idx) => {
    sheet1.addRow({
      no: idx + 1,
      ar: item[0],
      en: item[1]
    });
  });

  /* Sheet 2: Action Plan / CAPA */
  const sheet2 = workbook.addWorksheet("Action Plan (CAPA)");

  sheet2.columns = [
    { header: "No", key: "no", width: 6 },
    { header: "الوصف (AR)", key: "ar", width: 40 },
    { header: "Description (EN)", key: "en", width: 40 },
    { header: "Root Cause", key: "cause", width: 25 },
    { header: "Corrective Action", key: "action", width: 25 },
    { header: "Responsible", key: "resp", width: 20 },
    { header: "Due Date", key: "date", width: 15 }
  ];

  for (let i = 1; i <= 5; i++) {
    sheet2.addRow({ no: i });
  }

  const dir = path.join(__dirname, "public", "files");
  fs.mkdirSync(dir, { recursive: true });

  const filename = `audit_checklist_${Date.now()}.xlsx`;
  const filepath = path.join(dir, filename);

  await workbook.xlsx.writeFile(filepath);
  return filename;
}

/* =====================
   Routes
===================== */

app.get("/", (req, res) => {
  res.send(`${BOT_NAME} running ✅`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Serve files
app.use("/files", express.static(path.join(__dirname, "public", "files")));

/**
 * Telegram Webhook
 * URL: https://YOUR_DOMAIN/telegram/webhook
 */
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200); // لازم 200 فوراً

  try {
    console.log("📩 Telegram update:", JSON.stringify(req.body));

    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

    // Commands
    if (text === "/start" || text === "/help") {
      await sendTelegram(
        chatId,
        `مرحباً 👋 أنا ${BOT_NAME}.\n\n` +
          `اكتب سؤالك مباشرة في:\n` +
          `• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي\n\n` +
          `أمثلة:\n` +
          `- كيف أطبق HACCP في مخبز صغير؟\n` +
          `- اعمل لي checklist مراجعة داخلية لقسم الجودة في مخبز\n` +
          `- ابني KPI dashboard outline لقسم الجودة`
      );
      return;
    }

    // Excel trigger
    if (/نعم.*(اكسل|excel)|excel/i.test(text)) {
      const file = await generateExcelChecklist();
      const url = `${req.protocol}://${req.get("host")}/files/${file}`;

      await sendTelegram(
        chatId,
        `⬇️ تنزيل ملف Excel (Checklist + Action Plan):\n${url}`
      );
      return;
    }

    // AI answer
    try {
      const aiReply = await askAI(text);
      await sendTelegram(chatId, aiReply);
    } catch {
      await sendTelegram(
        chatId,
        "حدث خطأ في محرك الذكاء. جرّب تاني."
      );
    }
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
  }
});

/* =====================
   Start server
===================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
