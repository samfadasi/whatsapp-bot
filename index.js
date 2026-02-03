import express from "express";
import OpenAI from "openai";
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// =====================
// ENV
// =====================
const PORT = Number(process.env.PORT || 8080);
const BOT_NAME = (process.env.BOT_NAME || "QualiConsult AI").trim();

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

const TG_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : "";

console.log("=== STARTUP ENV CHECK ===");
console.log("PORT:", PORT);
console.log("BOT_NAME:", BOT_NAME);
console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? "OK" : "MISSING");
console.log("OPENAI_MODEL:", OPENAI_MODEL);
console.log("=========================");

// =====================
// OpenAI
// =====================
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// =====================
// Static files (Excel downloads)
// =====================
const FILES_DIR = path.join(process.cwd(), "public", "files");
fs.mkdirSync(FILES_DIR, { recursive: true });
app.use("/files", express.static(path.join(process.cwd(), "public", "files")));

// =====================
// Telegram helpers
// =====================
const TG_LIMIT = 3800;

function splitTelegram(text) {
  const s = (text || "").trim();
  if (!s) return [];
  if (s.length <= TG_LIMIT) return [s];
  const parts = [];
  let chunk = "";
  for (const line of s.split("\n")) {
    if ((chunk + "\n" + line).length > TG_LIMIT) {
      parts.push(chunk.trim());
      chunk = line;
    } else {
      chunk += (chunk ? "\n" : "") + line;
    }
  }
  if (chunk.trim()) parts.push(chunk.trim());
  return parts;
}

async function tgSend(chatId, text) {
  if (!TG_API) return false;
  const resp = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await resp.text();
  console.log("📤 Telegram send:", resp.status, body);
  return resp.ok;
}

async function tgSendMany(chatId, text) {
  for (const p of splitTelegram(text)) {
    await tgSend(chatId, p);
  }
}

// =====================
// RAM Sessions (TEMP)
// =====================
const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function now() {
  return Date.now();
}
function getSession(chatId) {
  const s = SESSIONS.get(String(chatId));
  if (!s) return null;
  if (now() - s.updated_at > SESSION_TTL_MS) {
    SESSIONS.delete(String(chatId));
    return null;
  }
  return s;
}
function setSession(chatId, patch) {
  const key = String(chatId);
  const old = SESSIONS.get(key) || {};
  SESSIONS.set(key, { ...old, ...patch, updated_at: now() });
}
function resetSession(chatId) {
  SESSIONS.delete(String(chatId));
}

// =====================
// Prompts
// =====================
function systemPrompt() {
  return `
أنت "QualiConsult AI" مستشار تقني متخصص في:
- الجودة (QMS / ISO 9001)
- سلامة الغذاء (FSMS / HACCP / ISO 22000 / GMP)
- الصحة والسلامة المهنية (OHS)
- التميز المؤسسي
- KPI / BSC / OKR
- Lean / RCA / CAPA

قواعد الرد:
1) عملي مباشر، بدون حشو أو تحية متكررة.
2) تشخيص سريع ثم خطوات تنفيذية.
3) إذا السؤال ناقص: اسأل سؤالًا حاسمًا واحدًا فقط.
4) عند طلب checklist / template / form: قدم نموذج جاهز.
5) لا تعُد للبداية في المتابعة.
6) لغة عربية مبسطة + مصطلح إنجليزي بين قوسين عند الحاجة.
`.trim();
}

function helpText() {
  return (
    `مرحباً 👋 أنا ${BOT_NAME}.\n\n` +
    `مجالاتي:\n` +
    `• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي\n• Lean\n\n` +
    `أوامر:\n` +
    `/help – المساعدة\n` +
    `/reset – تصفير السياق\n\n` +
    `أمثلة:\n` +
    `- كيف أطبق HACCP في مخبز صغير؟\n` +
    `- اعمل لي checklist مراجعة داخلية لقسم الجودة في مخبز\n`
  );
}

// =====================
// Follow-up logic
// =====================
function normalizeYesNo(t) {
  const x = (t || "").trim().toLowerCase();
  const yes = ["نعم", "ايوه", "أيوا", "تمام", "ok", "yes", "أكيد", "موافق"];
  const no = ["لا", "no", "غير", "مش", "ما", "ابداً"];
  if (yes.includes(x)) return "yes";
  if (no.includes(x)) return "no";
  return null;
}
function isContinue(t) {
  const x = (t || "").trim().toLowerCase();
  return ["اكمل", "أكمل", "كمل", "تابع", "واصل", "continue"].includes(x);
}
function isShortFollowup(t) {
  return (t || "").trim().length > 0 && (t || "").trim().length <= 12;
}

// =====================
// Excel Generator (AR + EN, 2 Sheets)
// =====================
async function generateAuditExcel() {
  const wb = new ExcelJS.Workbook();

  // -------- Sheet 1: Checklist --------
  const s1 = wb.addWorksheet("Audit Checklist");
  s1.columns = [
    { header: "Area / البند", key: "area", width: 28 },
    { header: "Audit Question / سؤال المراجعة", key: "q", width: 45 },
    { header: "Requirement / المتطلب", key: "req", width: 30 },
    { header: "Status / الحالة", key: "status", width: 18 },
    { header: "Evidence / الدليل", key: "evidence", width: 30 },
    { header: "Auditor Comment / ملاحظات المدقق", key: "comment", width: 30 },
  ];

  s1.addRows([
    {
      area: "Raw Materials / المواد الخام",
      q: "Are raw materials approved and inspected?",
      req: "GMP / HACCP",
    },
    {
      area: "Storage / التخزين",
      q: "Are storage temperature and hygiene controlled?",
      req: "GMP",
    },
    {
      area: "Production / الإنتاج",
      q: "Are SOPs followed during production?",
      req: "ISO 9001 / HACCP",
    },
    {
      area: "Cleaning / النظافة",
      q: "Is cleaning and sanitation program implemented?",
      req: "GMP",
    },
  ]);

  // -------- Sheet 2: Action Plan --------
  const s2 = wb.addWorksheet("Action Plan");
  s2.columns = [
    { header: "Finding Ref / رقم الملاحظة", key: "ref", width: 22 },
    { header: "Non-Conformity / عدم المطابقة", key: "nc", width: 40 },
    { header: "Root Cause / السبب الجذري", key: "rc", width: 30 },
    { header: "Corrective Action / الإجراء التصحيحي", key: "ca", width: 35 },
    { header: "Responsible / المسؤول", key: "resp", width: 22 },
    { header: "Target Date / تاريخ الإغلاق", key: "date", width: 20 },
    { header: "Status / الحالة", key: "status", width: 18 },
    { header: "Verification / التحقق", key: "ver", width: 28 },
  ];

  const filename = `internal_audit_bakery_${new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "")}.xlsx`;

  const filepath = path.join(FILES_DIR, filename);
  await wb.xlsx.writeFile(filepath);

  return filename;
}

// =====================
// AI Core
// =====================
async function askAI(chatId, userText) {
  if (!openai) return "❌ محرك الذكاء غير مهيأ.";

  const session = getSession(chatId);
  const yn = normalizeYesNo(userText);
  const cont = isContinue(userText);

  let stitchedUserText = userText;

  if (cont && session?.last_reply) {
    stitchedUserText =
      `أكمل من حيث توقفت:\n${session.last_reply}\n\nتابع الآن بتفاصيل عملية إضافية.`;
  }

  if (!cont && yn && session?.awaiting_excel) {
    if (yn === "yes") {
      const file = await generateAuditExcel();
      const link = `/files/${file}`;
      setSession(chatId, { awaiting_excel: false });
      return (
        `تم إنشاء نموذج Excel (Sheetين AR+EN) ✅\n\n` +
        `رابط التحميل:\n${link}\n\n` +
        `هل ترغب بتعديله حسب معيار معين (ISO 22000 / BRCGS)؟`
      );
    } else {
      setSession(chatId, { awaiting_excel: false });
      return "تمام. إذا احتجت النموذج لاحقًا قل: أريد Excel.";
    }
  }

  if (!cont && !yn && session?.last_reply && isShortFollowup(userText)) {
    stitchedUserText =
      `اعتبر هذه متابعة للسياق السابق:\n${session.last_reply}\n\nتابع بشكل عملي.`;
  }

  const context = [];
  if (session?.last_question && session?.last_reply) {
    context.push({ role: "user", content: session.last_question });
    context.push({ role: "assistant", content: session.last_reply });
  }

  try {
    const resp = await openai.responses.create({
      model: OPENAI_MODEL,
      max_output_tokens: 700,
      input: [
        { role: "system", content: systemPrompt() },
        ...context,
        { role: "user", content: stitchedUserText },
      ],
    });

    const answer = (resp.output_text || "").trim();

    // إذا الرد فيه checklist → اعرض خيار Excel
    const askExcel =
      /checklist|قائمة تحقق|مراجعة داخلية/i.test(userText);

    setSession(chatId, {
      last_question: userText,
      last_reply: answer,
      awaiting_excel: askExcel,
    });

    if (askExcel) {
      return (
        answer +
        `\n\nهل ترغب في تحويل هذه القائمة إلى نموذج Excel (Sheetين AR+EN)؟`
      );
    }

    return answer || "لم أتمكن من توليد رد الآن.";
  } catch (e) {
    console.error("AI error:", e);
    return "حدث خطأ في محرك الذكاء. جرّب مرة أخرى.";
  }
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();
    if (!chatId || !text) return;

    if (text === "/help" || text === "/start") {
      await tgSendMany(chatId, helpText());
      return;
    }
    if (text === "/reset") {
      resetSession(chatId);
      await tgSend(chatId, "تم تصفير السياق ✅");
      return;
    }

    const answer = await askAI(chatId, text);
    await tgSendMany(chatId, answer);
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
