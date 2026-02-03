import express from "express";
import OpenAI from "openai";

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

const TG_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : "";

const mask = (s) => (s ? `${s.slice(0, 4)}...${s.slice(-4)} (len=${s.length})` : "(missing)");
console.log("=== STARTUP ENV CHECK ===");
console.log("PORT:", PORT);
console.log("BOT_NAME:", BOT_NAME);
console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
console.log("OPENAI_MODEL:", OPENAI_MODEL);
console.log("=========================");

// =====================
// OpenAI client
// =====================
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// =====================
// Telegram helpers
// =====================
const TG_LIMIT = 3800; // keep margin

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
  const parts = splitTelegram(text);
  for (const p of parts) {
    await tgSend(chatId, p);
  }
}

// =====================
// RAM Sessions (TEMP)
// =====================
// NOTE: This is NOT database memory. It is in-memory only, for better dialogue flow.
// TTL: 30 minutes
const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function now() {
  return Date.now();
}

function getSession(chatId) {
  const key = String(chatId);
  const s = SESSIONS.get(key);
  if (!s) return null;
  if (now() - s.updated_at > SESSION_TTL_MS) {
    SESSIONS.delete(key);
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
// Bot Personality
// =====================
function systemPrompt() {
  return `
أنت "QualiConsult AI" مستشار تقني متخصص في:
- الجودة (QMS / ISO 9001)
- سلامة الغذاء (FSMS / HACCP / ISO 22000 / GMP)
- الصحة والسلامة المهنية (OHS) عند الحاجة
- التميز المؤسسي
- KPI/BSC/OKR
- Lean / RCA / CAPA

قواعد الرد:
1) عملي مباشر، بدون حشو وبدون تكرار التحية كل مرة.
2) ابدأ بتشخيص سريع (سطرين) ثم خطوات تنفيذية قابلة للتطبيق.
3) إذا السؤال ناقص: اسأل سؤال واحد "حاسم" فقط، ثم اقترح افتراضًا معقولًا إذا لم يرد المستخدم.
4) عند طلب (checklist / form / template / report): قدم نموذج جاهز للنسخ + حقول واضحة.
5) لا تنهِ الرد بسؤال عام مثل: "كيف أساعدك؟" — فقط اسأل سؤال متابعة محدد عند الضرورة.
6) اللغة: العربية المبسطة، واستخدم مصطلح إنجليزي بين قوسين عند الحاجة.
  `.trim();
}

function helpText() {
  return (
    `مرحباً 👋 أنا ${BOT_NAME}.\n\n` +
    `اكتب سؤالك مباشرة في:\n` +
    `• الجودة\n• سلامة الغذاء\n• HACCP\n• KPI\n• التميز المؤسسي\n• Lean\n\n` +
    `أوامر مفيدة:\n` +
    `/help – المساعدة\n` +
    `/reset – تصفير سياق المحادثة\n\n` +
    `أمثلة:\n` +
    `- كيف أطبق HACCP في مخبز صغير؟\n` +
    `- اعمل لي checklist مراجعة داخلية لقسم الجودة في مخبز\n` +
    `- ابني KPI dashboard outline لقسم الجودة\n`
  );
}

// =====================
// Follow-up logic (NO need to type "أكمل")
// =====================
function normalizeYesNo(t) {
  const x = (t || "").trim().toLowerCase();
  const yes = ["نعم", "ايوه", "أيوا", "تمام", "ok", "yes", "موافق", "وافق", "صح", "أكيد", "تمامم"];
  const no = ["لا", "no", "غير", "مو", "مش", "ما", "ابداً", "رفض", "لاا"];
  if (yes.includes(x)) return "yes";
  if (no.includes(x)) return "no";
  return null;
}

function isContinue(t) {
  const x = (t || "").trim().toLowerCase();
  const cont = [
    "اكمل", "أكمل", "كمل", "كمّل", "تابع", "واصل",
    "continue", "go on", "more", "زيد", "زيدني",
    "كمل من هنا", "كمل من آخر نقطة", "continue from last"
  ];
  return cont.includes(x);
}

function isShortFollowup(text) {
  const t = (text || "").trim();
  if (!t) return false;
  // short confirmations / nudges that should continue context
  // examples: "تمام", "اوكي", "كويس", "تمام جدا", "حلو", "زيد", "طيب"
  return t.length <= 12;
}

// =====================
// AI Core
// =====================
async function askAI(chatId, userText) {
  if (!openai) return "❌ OPENAI_API_KEY غير موجود في متغيرات Railway.";

  const session = getSession(chatId);

  const yn = normalizeYesNo(userText);
  const cont = isContinue(userText);

  let stitchedUserText = userText;

  // 1) If user explicitly says continue -> continue from last reply
  if (cont && session?.last_reply) {
    stitchedUserText =
      `أكمل من حيث توقفت في الرد السابق بدون إعادة ما قيل.\n` +
      `الرد السابق:\n${session.last_reply}\n\n` +
      `أكمل الآن بتفاصيل عملية إضافية (خطوات + أمثلة + نماذج مختصرة عند الحاجة).`;
  }

  // 2) If user answered yes/no and we had a followup question -> bind it
  if (!cont && yn && session?.last_followup_question) {
    stitchedUserText =
      `سؤال المتابعة السابق كان: "${session.last_followup_question}"\n` +
      `إجابتي عليه الآن هي: "${userText}"\n` +
      `الآن أكمل الحل بناءً على هذه الإجابة مباشرة، بدون إعادة الأسئلة القديمة أو التحية.`;
  }

  // 3) If user wrote a short message and we have context -> treat it as continue
  if (!cont && !yn && session?.last_reply && isShortFollowup(userText)) {
    stitchedUserText =
      `اعتبر هذه الرسالة متابعة للسياق السابق.\n` +
      `السياق السابق:\n${session.last_reply}\n\n` +
      `تابع الآن بشكل عملي ومباشر مع إضافة نقاط تنفيذية ونماذج إذا كانت مناسبة.`;
  }

  // Lightweight context: last Q + last reply
  const context = [];
  if (session?.last_question && session?.last_reply) {
    context.push({
      role: "user",
      content: `السياق السابق (للاستمرارية فقط): سؤالي كان: ${session.last_question}`,
    });
    context.push({
      role: "assistant",
      content: `وكان ردك: ${session.last_reply}`,
    });
  }

  try {
    const resp = await openai.responses.create({
      model: OPENAI_MODEL,
      max_output_tokens: 650, // more room to avoid cut-offs
      input: [
        { role: "system", content: systemPrompt() },
        ...context,
        { role: "user", content: stitchedUserText },
      ],
    });

    const out = (resp.output_text || "").trim();
    const answer = out || "ما قدرت أطلع رد الآن. جرّب تاني.";

    // Heuristic: if last non-empty line ends with "؟" treat as followup
    const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    const followup = lastLine.endsWith("؟") ? lastLine : "";

    setSession(chatId, {
      last_question: userText,
      last_reply: answer,
      last_followup_question: followup || "",
    });

    return answer;
  } catch (err) {
    console.error("❌ OpenAI error:", err?.status, err?.message || err);
    return "حدث خطأ في محرك الذكاء. جرّب تاني.";
  }
}
app.use("/files", express.static("public/files"));

// =====================
// Routes
// =====================
app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true }));

// Test AI from browser
app.get("/ai-test", async (req, res) => {
  const q = (req.query.q || "اختبار").toString();
  const ans = await askAI("test", q);
  res.json({ ok: true, model: OPENAI_MODEL, answer: ans });
});

// Telegram Webhook
app.post("/telegram/webhook", async (req, res) => {
  // respond fast
  res.sendStatus(200);

  try {
    console.log("📩 Telegram update:", JSON.stringify(req.body));

    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

    // Commands
    if (text.startsWith("/")) {
      if (text === "/help" || text === "/start") {
        await tgSendMany(chatId, helpText());
        return;
      }
      if (text === "/reset") {
        resetSession(chatId);
        await tgSend(chatId, "تم تصفير سياق المحادثة ✅\nاكتب سؤالك من جديد.");
        return;
      }
      await tgSend(chatId, "أمر غير معروف. استخدم /help");
      return;
    }

    // Normal messages
    const answer = await askAI(chatId, text);
    await tgSendMany(chatId, answer);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await tgSend(chatId, "حدث خطأ عام. جرّب تاني.");
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("MODEL:", OPENAI_MODEL);
});
