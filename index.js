import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);
const BOT_NAME = (process.env.BOT_NAME || "QualiConsult AI").trim();

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

const TG_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : "";

// ===== Startup Check =====
const mask = (s) => (s ? `${s.slice(0, 4)}...${s.slice(-4)} (len=${s.length})` : "(missing)");
console.log("=== STARTUP ENV CHECK ===");
console.log("PORT:", PORT);
console.log("BOT_NAME:", BOT_NAME);
console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
console.log("OPENAI_MODEL:", OPENAI_MODEL);
console.log("=========================");

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===== Telegram Limits =====
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
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const body = await resp.text();
  console.log("📤 Telegram send:", resp.status, body);
  return resp.ok;
}

async function tgSendMany(chatId, text) {
  const parts = splitTelegram(text);
  for (const p of parts) {
    // small pause reduces rate issues
    await tgSend(chatId, p);
  }
}

// ===== Session (RAM) — مؤقت =====
// key: chatId -> { last_intent, last_question, last_reply, last_followup_question, updated_at }
const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function now() { return Date.now(); }
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

// ===== Prompts =====
function systemPrompt() {
  return `
أنت "QualiConsult AI" مستشار تقني متخصص في:
- الجودة QMS (ISO 9001)
- سلامة الغذاء FSMS (HACCP / ISO 22000 / GMP)
- الصحة والسلامة المهنية (OHS basics) عند الحاجة
- التميز المؤسسي
- KPI/BSC/OKR
- Lean / RCA / CAPA

قواعد الرد:
1) أسلوب عملي مباشر. لا حشو. لا إعادة تحية كل مرة.
2) ابدأ بتشخيص سريع (سطرين) ثم خطوات تنفيذية.
3) إذا السؤال ناقص: اسأل "سؤال واحد" فقط كمتطلب حاسم ثم اقترح افتراضًا معقولًا لو ما رد.
4) عند طلب (checklist / form / template / report): قدم نموذج جاهز للنسخ + حقول واضحة.
5) قسم الإجابة بعناوين قصيرة ونقاط. أقصى طول: ~500-700 كلمة إلا إذا المستخدم طلب "تفصيل".
6) اللغة: العربية الفصحى المبسطة. استخدم مصطلحات إنجليزية بين قوسين عند الحاجة.
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

function normalizeYesNo(t) {
  const x = (t || "").trim().toLowerCase();
  const yes = ["نعم", "ايوه", "أيوا", "تمام", "ok", "yes", "موافق", "وافق", "صح", "أكيد"];
  const no = ["لا", "no", "غير", "مو", "مش", "ما", "ابداً", "رفض"];
  if (yes.includes(x)) return "yes";
  if (no.includes(x)) return "no";
  return null;
}

// ===== AI Core =====
async function askAI(chatId, userText) {
  if (!openai) return "❌ OPENAI_API_KEY غير موجود في متغيرات Railway.";

  const session = getSession(chatId);

  // لو المستخدم رد "نعم/لا" وفي سؤال متابعة سابق، نلحقه بالسياق
  const yn = normalizeYesNo(userText);
  let stitchedUserText = userText;
  if (yn && session?.last_followup_question) {
    stitchedUserText =
      `السؤال السابق الذي سألته لي هو: "${session.last_followup_question}"\n` +
      `ردي عليه هو: "${userText}"\n` +
      `الآن أكمل الحل بناءً على هذا الرد، بدون إعادة الأسئلة القديمة.`;
  }

  // Context small: آخر سؤال + آخر رد
  const context = [];
  if (session?.last_question && session?.last_reply) {
    context.push({ role: "user", content: `السياق السابق: سؤالي كان: ${session.last_question}` });
    context.push({ role: "assistant", content: `وردك كان: ${session.last_reply}` });
  }

  try {
    const resp = await openai.responses.create({
      model: OPENAI_MODEL,
      max_output_tokens: 520,
      input: [
        { role: "system", content: systemPrompt() },
        ...context,
        { role: "user", content: stitchedUserText }
      ]
    });

    const out = (resp.output_text || "").trim();
    const answer = out || "ما قدرت أطلع رد الآن. جرّب تاني.";

    // محاولة التقاط سؤال متابعة من النموذج (heuristic)
    // لو آخر سطر انتهى بعلامة استفهام، اعتبره followup
    const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    const followup = lastLine.endsWith("؟") ? lastLine : "";

    setSession(chatId, {
      last_question: userText,
      last_reply: answer,
      last_followup_question: followup || ""
    });

    return answer;
  } catch (err) {
    console.error("❌ OpenAI error:", err?.status, err?.message || err);
    return "حدث خطأ في محرك الذكاء. جرّب تاني.";
  }
}

// ===== Routes =====
app.get("/", (req, res) => res.send(`${BOT_NAME} running ✅`));
app.get("/health", (req, res) => res.json({ ok: true }));

// اختبار مباشر بدون تيليجرام
app.get("/ai-test", async (req, res) => {
  const q = (req.query.q || "اختبار").toString();
  const ans = await askAI("test", q);
  res.json({ ok: true, model: OPENAI_MODEL, answer: ans });
});

// Telegram webhook
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("📩 Telegram update:", JSON.stringify(req.body));

    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return;

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
