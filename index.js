import express from "express";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;

/* =====================
   BASIC SETUP
===================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_NAME = process.env.BOT_NAME || "QualiConsult AI";

/* =====================
   ENV NORMALIZATION
===================== */
function clean(v) {
  return String(v || "").trim().replace(/^"+|"+$/g, "");
}

function cleanModel(v) {
  let s = clean(v);
  return s.replace(/^OPENAI_MODEL\s*=\s*/i, "") || "gpt-4.1-mini";
}

const TELEGRAM_TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN);
const OPENAI_API_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = cleanModel(process.env.OPENAI_MODEL);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =====================
   DATABASE (SESSION MEMORY)
===================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function loadSession(chatId) {
  const { rows } = await pool.query(
    "SELECT context_summary FROM sessions WHERE chat_id = $1",
    [chatId]
  );
  return rows[0]?.context_summary || "";
}

async function saveSession(chatId, summary) {
  await pool.query(
    `INSERT INTO sessions (chat_id, context_summary, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chat_id)
     DO UPDATE SET context_summary = EXCLUDED.context_summary,
                   updated_at = NOW()`,
    [chatId, summary]
  );
}

/* =====================
   HELPERS
===================== */
function splitTelegram(text, limit = 3500) {
  const parts = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if ((buf + line).length > limit) {
      parts.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

async function sendTelegram(chatId, text) {
  const parts = splitTelegram(text);
  for (const part of parts) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part })
    });
  }
}

/* =====================
   AI ENGINE (STABLE)
===================== */
async function askAI(userText, contextSummary = "") {
  const reqId = crypto.randomUUID().slice(0, 8);
  const models = [OPENAI_MODEL, "gpt-4.1-mini", "gpt-4.1"];

  const input = [
    {
      role: "system",
      content:
        "You are a senior technical consultant in Quality, Food Safety, HACCP, KPI, and Operational Excellence. " +
        "Respond primarily in Arabic with structured, practical steps. " +
        "If the answer is long, continue automatically without asking the user to say continue."
    },
    ...(contextSummary
      ? [{ role: "system", content: `Previous context:\n${contextSummary}` }]
      : []),
    { role: "user", content: userText }
  ];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await Promise.race([
          openai.responses.create({
            model,
            input,
            max_output_tokens: 1200
          }),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("TIMEOUT")), 20000)
          )
        );

        const out =
          res.output_text ||
          res.output?.[0]?.content?.[0]?.text ||
          "";

        if (out.trim()) return out.trim();
      } catch (e) {
        console.log(`AI_FAIL ${reqId} model=${model} attempt=${attempt}`);
      }
    }
  }

  throw new Error("AI_ENGINE_FAILED");
}

/* =====================
   EXCEL GENERATION
===================== */
async function generateExcel() {
  const wb = new ExcelJS.Workbook();

  const s1 = wb.addWorksheet("Checklist");
  s1.columns = [
    { header: "No", key: "n", width: 6 },
    { header: "البند (AR)", key: "ar", width: 40 },
    { header: "Item (EN)", key: "en", width: 40 },
    { header: "Yes/No", key: "yn", width: 12 },
    { header: "Notes", key: "notes", width: 25 }
  ];

  [
    ["دليل جودة معتمد", "Approved quality manual"],
    ["إجراءات تشغيل (SOPs)", "Operating procedures"],
    ["سجلات تدريب", "Training records"],
    ["فحص المواد الخام", "Raw material inspection"],
    ["مراقبة درجات الحرارة", "Temperature monitoring"],
    ["نظافة وتعقيم", "Cleaning & sanitation"],
    ["فحص المنتج النهائي", "Final inspection"]
  ].forEach((r, i) =>
    s1.addRow({ n: i + 1, ar: r[0], en: r[1] })
  );

  const s2 = wb.addWorksheet("Action Plan");
  s2.columns = [
    { header: "No", key: "n", width: 6 },
    { header: "الوصف (AR)", key: "ar", width: 40 },
    { header: "Description (EN)", key: "en", width: 40 },
    { header: "Root Cause", key: "rc", width: 25 },
    { header: "Action", key: "ac", width: 25 },
    { header: "Owner", key: "ow", width: 20 },
    { header: "Due Date", key: "dd", width: 15 }
  ];

  for (let i = 1; i <= 5; i++) s2.addRow({ n: i });

  const dir = path.join(__dirname, "public", "files");
  fs.mkdirSync(dir, { recursive: true });

  const name = `qualiconsult_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(path.join(dir, name));
  return name;
}

/* =====================
   ROUTES
===================== */
app.get("/", (_, r) => r.send(`${BOT_NAME} running ✅`));
app.get("/health", (_, r) => r.json({ ok: true }));
app.use("/files", express.static(path.join(__dirname, "public", "files")));

/* =====================
   TELEGRAM WEBHOOK
===================== */
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim();

  if (!chatId || !text) return;

  if (text === "/start" || text === "/help") {
    await sendTelegram(
      chatId,
      `مرحباً 👋 أنا ${BOT_NAME}.\n\n` +
        `اكتب سؤالك مباشرة في:\n` +
        `• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي`
    );
    return;
  }

  if (/نعم.*(اكسل|excel)|excel/i.test(text)) {
    const f = await generateExcel();
    const url = `${req.protocol}://${req.get("host")}/files/${f}`;
    await sendTelegram(chatId, `⬇️ تنزيل ملف Excel:\n${url}`);
    return;
  }

  try {
    const prev = await loadSession(chatId);
    const reply = await askAI(text, prev);
    await sendTelegram(chatId, reply);
    const summary = (prev + " " + text).slice(-1200);
    await saveSession(chatId, summary);
  } catch {
    await sendTelegram(chatId, "حدث خطأ في محرك الذكاء. جرّب تاني.");
  }
});

/* =====================
   START
===================== */
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
