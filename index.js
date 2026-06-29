"use strict";
const express = require("express");

// ── Express app — start immediately so healthcheck works ──────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check — always works, no Firebase needed
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.json({ status: "ok", name: "Loot Box Bot" }));

// ── Start server FIRST — so Railway healthcheck passes immediately ─────────
const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Loot Box Bot running on port " + PORT);
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) console.warn("⚠️  Set FIREBASE_SERVICE_ACCOUNT in Railway Variables");
  if (!process.env.TELEGRAM_BOT_TOKEN)       console.warn("⚠️  Set TELEGRAM_BOT_TOKEN in Railway Variables");
});

// ── Firebase — lazy init (only when first request needs it) ───────────────
let db;
function getDb() {
  if (db) return db;
  // Lazy require — firebase-admin loads only when first needed, not at startup
  const admin = require("firebase-admin");
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT env var not set in Railway Variables.");
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  }
  db = admin.firestore();
  return db;
}

function getAdmin() {
  require("firebase-admin");
  return require("firebase-admin");
}

function getTimestamp() {
  return require("firebase-admin").firestore.Timestamp;
}

function fromDoc(doc) {
  const data = doc.data();
  const result = { id: doc.id, ...data };
  for (const k of Object.keys(result)) {
    if (result[k] && typeof result[k].toDate === "function") result[k] = result[k].toDate();
  }
  return result;
}

// ── Telegram helper ───────────────────────────────────────────────────────
const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || "";
async function tg(method, body) {
  const t = BOT_TOKEN(); if (!t) return;
  await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}
const sendMsg  = (chatId, text, extra = {}) => tg("sendMessage",       { chat_id: chatId, text, parse_mode: "HTML", ...extra });
const answerCb = (id)                        => tg("answerCallbackQuery", { callback_query_id: id });

// ── Keyboard ──────────────────────────────────────────────────────────────
const KEYS = {
  keyboard: [
    [{ text: "💰 My Balance" }, { text: "🎁 Daily Bonus" }],
    [{ text: "👥 Invite Friends" }, { text: "📋 Tasks" }],
    [{ text: "💸 Withdraw" }, { text: "ℹ️ Help" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ── Constants ─────────────────────────────────────────────────────────────
const REF_BONUS   = 10;
const DAILY_BONUS = 5;
const MIN_WITHDRAW = 100;

// ── User helpers ──────────────────────────────────────────────────────────
async function getUser(id) {
  const doc = await getDb().collection("users").doc(String(id)).get();
  return doc.exists ? fromDoc(doc) : null;
}
async function upsertUser(from, referredBy) {
  const existing = await getUser(from.id);
  if (existing) return existing;
  const admin = require("firebase-admin");
  const now  = admin.firestore.Timestamp.now();
  const user = {
    id: from.id,
    username: from.username || null,
    firstName: from.first_name || "User",
    lastName: from.last_name || null,
    referredBy: referredBy || null,
    balance: 0, totalEarned: 0, totalReferrals: 0,
    lastDailyBonus: null, isBanned: false, createdAt: now,
  };
  await getDb().collection("users").doc(String(from.id)).set(user);
  if (referredBy && referredBy !== from.id) {
    const referrer = await getUser(referredBy);
    if (referrer) {
      await getDb().collection("users").doc(String(referredBy)).update({
        balance: referrer.balance + REF_BONUS,
        totalEarned: referrer.totalEarned + REF_BONUS,
        totalReferrals: referrer.totalReferrals + 1,
      });
      await sendMsg(referredBy, `🎉 <b>Referral Bonus!</b>\n\n✅ <b>${from.first_name}</b> joined via your link!\n💰 You earned <b>₹${REF_BONUS}</b>! 🚀`);
    }
  }
  return { ...user, createdAt: new Date() };
}

// ── Telegram webhook ──────────────────────────────────────────────────────
app.post("/api/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  try {
    const admin = require("firebase-admin");

    // Callback queries (button clicks)
    if (update.callback_query) {
      const cb = update.callback_query;
      const { from, data = "" } = cb;
      const chatId = cb.message?.chat?.id;
      if (!chatId || !from) return;
      const user = await upsertUser(from);
      await answerCb(cb.id);

      if (data.startsWith("complete_task_")) {
        const taskId = data.replace("complete_task_", "");
        const taskDoc = await getDb().collection("tasks").doc(taskId).get();
        if (!taskDoc.exists) { await sendMsg(chatId, "❌ Task not found."); return; }
        const task = fromDoc(taskDoc);
        const done = await getDb().collection("task_completions")
          .where("userId", "==", user.id).where("taskId", "==", taskId).limit(1).get();
        if (!done.empty) { await sendMsg(chatId, "✅ Already completed!"); return; }
        await getDb().collection("task_completions").add({ userId: user.id, taskId, createdAt: admin.firestore.Timestamp.now() });
        await getDb().collection("users").doc(String(user.id)).update({
          balance: user.balance + task.reward, totalEarned: user.totalEarned + task.reward,
        });
        await sendMsg(chatId, `🎉 <b>Task Completed!</b>\n\n✅ <b>${task.title}</b>\n💰 Earned: <b>₹${task.reward}</b>\n💼 Balance: <b>₹${user.balance + task.reward}</b>`);
        return;
      }
      if (data === "withdraw_upi")  { await sendMsg(chatId, "📱 <b>UPI Withdrawal</b>\n\nSend like:\n<code>upi yourname@paytm</code>"); return; }
      if (data === "withdraw_bank") { await sendMsg(chatId, "🏦 <b>Bank Withdrawal</b>\n\nSend like:\n<code>bank ACCOUNT_NO IFSC HOLDER_NAME</code>"); return; }
      return;
    }

    if (!update.message) return;
    const { message } = update;
    const from = message.from;
    const chatId = message.chat.id;
    const text = (message.text || "").trim();
    if (!from || from.is_bot) return;

    // UPI withdrawal
    if (text.toLowerCase().startsWith("upi ")) {
      const user  = await upsertUser(from);
      const upiId = text.slice(4).trim();
      if (!upiId.includes("@")) { await sendMsg(chatId, "❌ Invalid UPI. Example: <code>upi name@paytm</code>"); return; }
      if (user.balance < MIN_WITHDRAW) { await sendMsg(chatId, `❌ Balance ₹${user.balance} is below minimum ₹${MIN_WITHDRAW}.`); return; }
      const now = admin.firestore.Timestamp.now();
      await getDb().collection("withdrawals").add({ userId: user.id, amount: user.balance, method: "upi", upiId, status: "pending", adminNote: null, createdAt: now, updatedAt: now });
      await getDb().collection("users").doc(String(user.id)).update({ balance: 0 });
      await sendMsg(chatId, `✅ <b>Withdrawal Submitted!</b>\n\n💰 ₹${user.balance}\n📱 UPI: ${upiId}\n⏰ 1-3 business days`, { reply_markup: KEYS });
      return;
    }

    // Bank withdrawal
    if (text.toLowerCase().startsWith("bank ")) {
      const user  = await upsertUser(from);
      const parts = text.slice(5).trim().split(/\s+/);
      if (parts.length < 3) { await sendMsg(chatId, "❌ Format: <code>bank ACCOUNT_NO IFSC NAME</code>"); return; }
      const [accountNumber, ifscCode, ...rest] = parts;
      const accountName = rest.join(" ");
      if (user.balance < MIN_WITHDRAW) { await sendMsg(chatId, `❌ Balance ₹${user.balance} is below minimum ₹${MIN_WITHDRAW}.`); return; }
      const now = admin.firestore.Timestamp.now();
      await getDb().collection("withdrawals").add({ userId: user.id, amount: user.balance, method: "bank", accountNumber, ifscCode, accountName, status: "pending", adminNote: null, createdAt: now, updatedAt: now });
      await getDb().collection("users").doc(String(user.id)).update({ balance: 0 });
      await sendMsg(chatId, `✅ <b>Withdrawal Submitted!</b>\n\n💰 ₹${user.balance}\n🏦 ${accountNumber} / ${ifscCode}\n👤 ${accountName}\n⏰ 1-3 business days`, { reply_markup: KEYS });
      return;
    }

    // /start
    if (text.startsWith("/start")) {
      const refId = parseInt(text.split(" ")[1] || "0") || undefined;
      const user  = await upsertUser(from, refId);
      await sendMsg(chatId,
        `🎁 <b>Welcome to Loot Box!</b>\n\nHello <b>${from.first_name}</b>!\n\n💰 <b>How to Earn:</b>\n🔗 Invite friends → <b>₹${REF_BONUS}/referral</b>\n🎁 Daily bonus  → <b>₹${DAILY_BONUS}/day</b>\n📋 Tasks        → <b>Variable rewards</b>\n\n💸 Min Withdrawal: ₹${MIN_WITHDRAW}\n💰 Your Balance: ₹${user.balance}\n\n👇 Use the menu below!`,
        { reply_markup: KEYS });
      return;
    }

    const user = await upsertUser(from);
    const botU = process.env.BOT_USERNAME || "LootBoxEarningBot";
    const link = `https://t.me/${botU}?start=${user.id}`;

    if (text === "💰 My Balance" || text === "/balance") {
      await sendMsg(chatId, `💼 <b>Your Balance</b>\n\n💰 Balance: <b>₹${user.balance}</b>\n🏆 Total Earned: <b>₹${user.totalEarned}</b>\n👥 Referrals: <b>${user.totalReferrals}</b>\n\n🔗 Invite Link:\n<code>${link}</code>`, { reply_markup: KEYS });
      return;
    }

    if (text === "🎁 Daily Bonus") {
      const now  = new Date();
      const last = user.lastDailyBonus;
      const hrs  = last ? (now - new Date(last)) / 3600000 : 999;
      if (hrs < 24) {
        await sendMsg(chatId, `⏳ <b>Already Claimed!</b>\nNext in <b>${Math.ceil(24 - hrs)}h</b>.`, { reply_markup: KEYS });
        return;
      }
      await getDb().collection("users").doc(String(user.id)).update({
        balance: user.balance + DAILY_BONUS,
        totalEarned: user.totalEarned + DAILY_BONUS,
        lastDailyBonus: admin.firestore.Timestamp.now(),
      });
      await sendMsg(chatId, `🎉 <b>Daily Bonus Claimed!</b>\n💰 Received: <b>₹${DAILY_BONUS}</b>\n💼 Balance: <b>₹${user.balance + DAILY_BONUS}</b>\n⏰ Come back in 24h!`, { reply_markup: KEYS });
      return;
    }

    if (text === "👥 Invite Friends" || text === "/referral") {
      await sendMsg(chatId, `🔗 <b>Invite &amp; Earn!</b>\n💰 Earn <b>₹${REF_BONUS}</b> per friend!\n\n<b>Your Link:</b>\n<code>${link}</code>\n\n👥 Referrals: <b>${user.totalReferrals}</b>`, { reply_markup: KEYS });
      return;
    }

    if (text === "📋 Tasks") {
      const snap = await getDb().collection("tasks").where("isActive", "==", true).get();
      if (snap.empty) { await sendMsg(chatId, "📋 No tasks yet. Check back soon!", { reply_markup: KEYS }); return; }
      const doneSnap = await getDb().collection("task_completions").where("userId", "==", user.id).get();
      const doneSet  = new Set(doneSnap.docs.map(d => d.data().taskId));
      let txt = "📋 <b>Available Tasks</b>\n\n";
      const btns = [];
      snap.docs.forEach(d => {
        const t = fromDoc(d);
        const done = doneSet.has(t.id);
        txt += `${done ? "✅" : "🔹"} <b>${t.title}</b> — ₹${t.reward}\n<i>${t.description}</i>\n${t.link ? "🔗 " + t.link + "\n" : ""}\n`;
        if (!done) btns.push([{ text: `✅ Complete: ${t.title} (+₹${t.reward})`, callback_data: `complete_task_${t.id}` }]);
      });
      await sendMsg(chatId, txt, { reply_markup: { inline_keyboard: btns.length ? btns : [[{ text: "🎉 All Done!", callback_data: "noop" }]] } });
      return;
    }

    if (text === "💸 Withdraw") {
      if (user.balance < MIN_WITHDRAW) {
        await sendMsg(chatId, `💸 <b>Insufficient Balance</b>\n💰 Balance: <b>₹${user.balance}</b>\nMinimum: ₹${MIN_WITHDRAW}\n❌ Need ₹${MIN_WITHDRAW - user.balance} more.`, { reply_markup: KEYS });
        return;
      }
      await sendMsg(chatId, `💸 <b>Withdraw ₹${user.balance}</b>\nChoose method:`, {
        reply_markup: { inline_keyboard: [[{ text: "📱 UPI Transfer", callback_data: "withdraw_upi" }], [{ text: "🏦 Bank Transfer", callback_data: "withdraw_bank" }]] },
      });
      return;
    }

    if (text === "ℹ️ Help" || text === "/help") {
      await sendMsg(chatId, `ℹ️ <b>Loot Box — Help</b>\n\n🔹 Invite → ₹${REF_BONUS}/friend\n🎁 Daily → ₹${DAILY_BONUS}/day\n📋 Tasks → Variable\n💸 Withdraw min ₹${MIN_WITHDRAW}\n⏰ 1-3 business days`, { reply_markup: KEYS });
      return;
    }

    await sendMsg(chatId, "👋 Use the menu below!", { reply_markup: KEYS });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ── Admin middleware ──────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const s = req.headers["x-admin-secret"] || req.query.secret;
  if (s !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Admin API ─────────────────────────────────────────────────────────────
app.get("/api/admin/stats", adminAuth, async (_req, res) => {
  try {
    const [u, p, t, a] = await Promise.all([
      getDb().collection("users").count().get(),
      getDb().collection("withdrawals").where("status", "==", "pending").count().get(),
      getDb().collection("tasks").where("isActive", "==", true).count().get(),
      getDb().collection("withdrawals").where("status", "==", "approved").get(),
    ]);
    const totalWithdrawn = a.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    res.json({ totalUsers: u.data().count, pendingWithdrawals: p.data().count, activeTasks: t.data().count, totalWithdrawn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const snap = await getDb().collection("users").orderBy("createdAt", "desc").get();
    const all  = snap.docs.map(d => fromDoc(d));
    res.json({ users: all.slice((page-1)*50, page*50), total: all.length, page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/users/:id/ban", adminAuth, async (req, res) => {
  try {
    await getDb().collection("users").doc(req.params.id).update({ isBanned: req.body.banned });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/users/:id/balance", adminAuth, async (req, res) => {
  try {
    const doc = await getDb().collection("users").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });
    const newBalance = Math.max(0, doc.data().balance + req.body.amount);
    await getDb().collection("users").doc(req.params.id).update({ balance: newBalance });
    res.json({ success: true, newBalance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/withdrawals", adminAuth, async (req, res) => {
  try {
    const status = req.query.status;
    const page   = parseInt(req.query.page) || 1;
    let q = getDb().collection("withdrawals").orderBy("createdAt", "desc");
    if (status && status !== "all") q = q.where("status", "==", status);
    const snap = await q.get();
    const slice = snap.docs.slice((page-1)*50, page*50);
    const result = await Promise.all(slice.map(async d => {
      const w = fromDoc(d);
      const u = await getDb().collection("users").doc(String(w.userId)).get();
      return { withdrawal: w, user: u.exists ? fromDoc(u) : null };
    }));
    res.json({ withdrawals: result, page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/withdrawals/:id", adminAuth, async (req, res) => {
  try {
    const admin = require("firebase-admin");
    const { status, adminNote } = req.body;
    if (!["approved","rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const doc = await getDb().collection("withdrawals").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });
    const w = fromDoc(doc);
    await getDb().collection("withdrawals").doc(req.params.id).update({ status, adminNote: adminNote || null, updatedAt: admin.firestore.Timestamp.now() });
    if (status === "rejected") {
      const uDoc = await getDb().collection("users").doc(String(w.userId)).get();
      if (uDoc.exists) await getDb().collection("users").doc(String(w.userId)).update({ balance: uDoc.data().balance + w.amount });
    }
    const t = BOT_TOKEN();
    if (t) {
      const msg = status === "approved"
        ? `✅ <b>Withdrawal Approved!</b>\n💰 ₹${w.amount} sent. Thank you! 🎉`
        : `❌ <b>Withdrawal Rejected</b>\n💰 ₹${w.amount} refunded.${adminNote ? "\n📝 " + adminNote : ""}`;
      await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ chat_id: w.userId, text: msg, parse_mode: "HTML" }) }).catch(()=>{});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/tasks", adminAuth, async (_req, res) => {
  try {
    const snap = await getDb().collection("tasks").orderBy("createdAt", "desc").get();
    res.json({ tasks: snap.docs.map(d => fromDoc(d)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/tasks", adminAuth, async (req, res) => {
  try {
    const { title, description, reward, link } = req.body;
    if (!title || !description || !reward) return res.status(400).json({ error: "Missing fields" });
    const admin = require("firebase-admin");
    const ref = getDb().collection("tasks").doc();
    const task = { id: ref.id, title, description, reward: parseInt(reward), link: link || null, isActive: true, createdAt: admin.firestore.Timestamp.now() };
    await ref.set(task);
    res.json({ task: { ...task, createdAt: new Date() } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/tasks/:id", adminAuth, async (req, res) => {
  try {
    const { title, description, reward, link, isActive } = req.body;
    const upd = {};
    if (title !== undefined) upd.title = title;
    if (description !== undefined) upd.description = description;
    if (reward !== undefined) upd.reward = reward;
    if (link !== undefined) upd.link = link;
    if (isActive !== undefined) upd.isActive = isActive;
    await getDb().collection("tasks").doc(req.params.id).update(upd);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/tasks/:id", adminAuth, async (req, res) => {
  try {
    await getDb().collection("tasks").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/broadcast", adminAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const t = BOT_TOKEN(); if (!t) return res.status(500).json({ error: "No bot token" });
    const snap = await getDb().collection("users").where("isBanned", "==", false).get();
    let sent = 0, failed = 0;
    for (const d of snap.docs) {
      const uid = d.data().id || d.id;
      const r = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ chat_id: uid, text: `📢 <b>Announcement</b>\n\n${message}`, parse_mode: "HTML" }) }).catch(() => null);
      if (r) { const j = await r.json().catch(() => ({})); if (j.ok) sent++; else failed++; } else failed++;
      await new Promise(r => setTimeout(r, 40));
    }
    res.json({ success: true, sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin panel HTML ──────────────────────────────────────────────────────
app.get("/api/admin-panel", (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).send(`<!DOCTYPE html><html><head><title>Loot Box Admin</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border-radius:16px;padding:40px;width:360px;text-align:center}
h2{color:#f8fafc;margin-bottom:8px}p{color:#94a3b8;margin-bottom:24px;font-size:14px}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:15px;margin-bottom:16px;outline:none}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:15px;font-weight:600;cursor:pointer}</style></head>
<body><div class="card"><h2>🎁 Loot Box Admin</h2><p>Enter admin password</p>
<input type="password" id="p" placeholder="Admin Secret" onkeydown="if(event.key==='Enter')login()"/>
<button onclick="login()">Login</button></div>
<script>function login(){const s=document.getElementById('p').value;if(s)window.location.href='/api/admin-panel?secret='+encodeURIComponent(s);}</script>
</body></html>`);
  }
  res.send(getAdminHTML(secret));
});

function getAdminHTML(secret) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loot Box Admin</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f172a;color:#e2e8f0}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:200px;background:#1e293b;border-right:1px solid #334155;padding:20px 0}
.logo{padding:0 20px 20px;border-bottom:1px solid #334155;margin-bottom:12px}
.logo h1{font-size:16px;color:#f8fafc}.logo p{font-size:11px;color:#64748b}
.nav{display:block;padding:10px 20px;color:#94a3b8;font-size:13px;cursor:pointer;border-left:3px solid transparent}
.nav:hover,.nav.active{color:#f8fafc;background:#0f172a;border-left-color:#6366f1}
.main{margin-left:200px;padding:24px}.section{display:none}.section.active{display:block}
.h1{font-size:20px;font-weight:700;color:#f8fafc;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
.card{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155}
.lbl{font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:6px}
.val{font-size:24px;font-weight:700;color:#f8fafc}
table{width:100%;border-collapse:collapse}th{text-align:left;padding:8px 10px;font-size:11px;color:#64748b;border-bottom:1px solid #334155;text-transform:uppercase}
td{padding:10px;font-size:12px;color:#cbd5e1;border-bottom:1px solid #1e293b}tr:hover td{background:#243046}
.badge{padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700}
.bp{background:#422006;color:#fb923c}.ba{background:#052e16;color:#4ade80}.br{background:#450a0a;color:#f87171}
.btn{padding:4px 10px;border-radius:6px;border:none;font-size:11px;font-weight:600;cursor:pointer}
.b1{background:#1e3a5f;color:#60a5fa}.b2{background:#052e16;color:#4ade80}.b3{background:#450a0a;color:#f87171}.b4{background:#422006;color:#fb923c}
.empty{text-align:center;color:#475569;padding:32px}
input,textarea,select{background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f8fafc;padding:8px 12px;font-size:13px;width:100%;margin-bottom:10px;outline:none}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}
.modal.open{display:flex}.mbox{background:#1e293b;border-radius:12px;padding:24px;width:420px;max-width:95vw}
.mbox h3{color:#f8fafc;margin-bottom:16px}.mbox .row{display:flex;gap:8px;margin-top:4px}
.mbox .row button{flex:1;padding:10px;border-radius:8px;border:none;font-weight:600;cursor:pointer;font-size:13px}
.apr{background:#052e16;color:#4ade80}.rej{background:#450a0a;color:#f87171}.cls{background:#1e293b;color:#94a3b8;border:1px solid #334155}
</style></head><body>
<div class="sidebar">
<div class="logo"><h1>🎁 Loot Box</h1><p>Admin Panel</p></div>
<div class="nav active" onclick="show('stats')">📊 Dashboard</div>
<div class="nav" onclick="show('users')">👥 Users</div>
<div class="nav" onclick="show('withdrawals')">💸 Withdrawals</div>
<div class="nav" onclick="show('tasks')">📋 Tasks</div>
<div class="nav" onclick="show('broadcast')">📢 Broadcast</div>
</div>
<div class="main">
<div id="stats" class="section active">
<div class="h1">📊 Dashboard</div>
<div class="grid">
<div class="card"><div class="lbl">Total Users</div><div class="val" id="su">—</div></div>
<div class="card"><div class="lbl">Pending Withdrawals</div><div class="val" id="sp">—</div></div>
<div class="card"><div class="lbl">Active Tasks</div><div class="val" id="st">—</div></div>
<div class="card"><div class="lbl">Total Withdrawn</div><div class="val" id="sw">—</div></div>
</div></div>
<div id="users" class="section">
<div class="h1">👥 Users</div>
<table><thead><tr><th>ID</th><th>Name</th><th>Username</th><th>Balance</th><th>Earned</th><th>Refs</th><th>Status</th><th>Actions</th></tr></thead>
<tbody id="utb"><tr><td colspan="8" class="empty">Loading...</td></tr></tbody></table></div>
<div id="withdrawals" class="section">
<div class="h1">💸 Withdrawals</div>
<div style="margin-bottom:12px">
<select id="wf" onchange="loadW()" style="width:160px;margin-bottom:0">
<option value="all">All</option><option value="pending" selected>Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
</select></div>
<table><thead><tr><th>ID</th><th>User</th><th>Amount</th><th>Method</th><th>Details</th><th>Status</th><th>Date</th><th>Action</th></tr></thead>
<tbody id="wtb"><tr><td colspan="8" class="empty">Loading...</td></tr></tbody></table></div>
<div id="tasks" class="section">
<div class="h1" style="display:flex;align-items:center;justify-content:space-between">📋 Tasks <button class="btn b2" onclick="openTaskModal()">+ Add Task</button></div>
<table><thead><tr><th>Title</th><th>Description</th><th>Reward</th><th>Link</th><th>Status</th><th>Actions</th></tr></thead>
<tbody id="ttb"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody></table></div>
<div id="broadcast" class="section">
<div class="h1">📢 Broadcast</div>
<div class="card" style="max-width:500px">
<p style="color:#94a3b8;margin-bottom:12px;font-size:13px">Send message to all users</p>
<textarea id="bmsg" rows="5" placeholder="Type your message..."></textarea>
<button class="btn b2" style="width:100%;padding:10px" onclick="sendBcast()">Send Broadcast</button>
<p id="bres" style="margin-top:10px;font-size:12px;color:#94a3b8"></p></div></div>
</div>
<div class="modal" id="wm">
<div class="mbox"><h3>Review Withdrawal</h3><p id="wd" style="color:#94a3b8;font-size:13px;margin-bottom:12px"></p>
<input type="text" id="wn" placeholder="Admin note (optional)"/>
<div class="row"><button class="apr" onclick="procW('approved')">✅ Approve</button><button class="rej" onclick="procW('rejected')">❌ Reject</button><button class="cls" onclick="closeWM()">Cancel</button></div></div></div>
<div class="modal" id="tm">
<div class="mbox"><h3 id="tm-title">Add Task</h3>
<input type="text" id="tt" placeholder="Title *"/>
<textarea id="td" rows="3" placeholder="Description *"></textarea>
<input type="number" id="tr" placeholder="Reward (₹) *"/>
<input type="text" id="tl" placeholder="Link (optional)"/>
<div class="row"><button class="b2 btn" style="padding:10px" onclick="saveTask()">Save</button><button class="cls btn" style="padding:10px" onclick="closeTM()">Cancel</button></div></div></div>
<script>
const S='${secret}';
function show(id){document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));document.querySelectorAll('.nav').forEach(n=>n.classList.remove('active'));document.getElementById(id).classList.add('active');event.target.classList.add('active');if(id==='users')loadU();if(id==='tasks')loadT();}
async function api(path,opts={}){const r=await fetch('/api/admin'+path+'?secret='+S,{...opts,headers:{...opts.headers,'Content-Type':'application/json','x-admin-secret':S}});return r.json();}
function toast(msg,t='s'){const d=document.createElement('div');d.style='position:fixed;bottom:20px;right:20px;background:'+(t==='s'?'#052e16':'#450a0a')+';color:'+(t==='s'?'#4ade80':'#f87171')+';padding:10px 16px;border-radius:8px;font-size:13px;z-index:999';d.textContent=msg;document.body.appendChild(d);setTimeout(()=>d.remove(),3000);}
async function loadStats(){const d=await api('/stats');document.getElementById('su').textContent=d.totalUsers??'—';document.getElementById('sp').textContent=d.pendingWithdrawals??'—';document.getElementById('st').textContent=d.activeTasks??'—';document.getElementById('sw').textContent='₹'+(d.totalWithdrawn??0);}
async function loadU(){const d=await api('/users');const tb=document.getElementById('utb');const list=d.users||[];if(!list.length){tb.innerHTML='<tr><td colspan="8" class="empty">No users</td></tr>';return;}tb.innerHTML=list.map(u=>\`<tr><td>\${u.id}</td><td>\${u.firstName||''} \${u.lastName||''}</td><td>\${u.username?'@'+u.username:'—'}</td><td><b>₹\${u.balance||0}</b></td><td>₹\${u.totalEarned||0}</td><td>\${u.totalReferrals||0}</td><td><span class="badge \${u.isBanned?'br':'ba'}">\${u.isBanned?'Banned':'Active'}</span></td><td><button class="btn \${u.isBanned?'b2':'b3'}" onclick="togBan('\${u.id}',\${!u.isBanned})">\${u.isBanned?'Unban':'Ban'}</button></td></tr>\`).join('');}
async function togBan(id,b){await api('/users/'+id+'/ban',{method:'PATCH',body:JSON.stringify({banned:b})});toast(b?'Banned':'Unbanned',b?'e':'s');loadU();}
let curW=null;
async function loadW(){const f=document.getElementById('wf').value;const d=await api('/withdrawals?status='+f);const tb=document.getElementById('wtb');const list=d.withdrawals||[];if(!list.length){tb.innerHTML='<tr><td colspan="8" class="empty">No withdrawals</td></tr>';return;}tb.innerHTML=list.map(({withdrawal:w,user:u})=>\`<tr><td>#\${w.id?.slice(-6)||'?'}</td><td>\${u?.firstName||'?'}\${u?.username?' (@'+u.username+')':''}</td><td><b>₹\${w.amount}</b></td><td>\${w.method==='upi'?'📱 UPI':'🏦 Bank'}</td><td style="font-size:10px">\${w.method==='upi'?w.upiId:(w.accountNumber+'/'+(w.ifscCode||''))}</td><td><span class="badge \${w.status==='pending'?'bp':w.status==='approved'?'ba':'br'}">\${w.status}</span></td><td style="font-size:10px">\${w.createdAt?new Date(w.createdAt).toLocaleDateString():'?'}</td><td>\${w.status==='pending'?\`<button class="btn b1" onclick="openWM('\${w.id}','\${(w.upiId||w.accountNumber||'').replace(/'/g,'')}')">Review</button>\`:'—'}</td></tr>\`).join('');}
function openWM(id,d){curW=id;document.getElementById('wd').innerHTML='<b>Withdrawal #'+id.slice(-6)+'</b><br>'+d;document.getElementById('wn').value='';document.getElementById('wm').classList.add('open');}
function closeWM(){document.getElementById('wm').classList.remove('open');}
async function procW(s){if(!curW)return;const note=document.getElementById('wn').value;await api('/withdrawals/'+curW,{method:'PATCH',body:JSON.stringify({status:s,adminNote:note})});closeWM();toast(s==='approved'?'✅ Approved!':'❌ Rejected',s==='approved'?'s':'e');loadW();}
let editTId=null;
async function loadT(){const d=await api('/tasks');const tb=document.getElementById('ttb');const list=d.tasks||[];if(!list.length){tb.innerHTML='<tr><td colspan="6" class="empty">No tasks</td></tr>';return;}tb.innerHTML=list.map(t=>\`<tr><td>\${t.title}</td><td>\${t.description}</td><td><b>₹\${t.reward}</b></td><td>\${t.link?'<a href="'+t.link+'" target="_blank" style="color:#6366f1">Link</a>':'—'}</td><td><span class="badge \${t.isActive?'ba':'br'}">\${t.isActive?'Active':'Off'}</span></td><td><button class="btn b1" onclick="editT('\${t.id}',\`\${t.title}\`,\`\${t.description}\`,\${t.reward},'\${t.link||''}')">Edit</button> <button class="btn \${t.isActive?'b4':'b2'}" onclick="togT('\${t.id}',\${!t.isActive})" style="margin-left:4px">\${t.isActive?'Off':'On'}</button> <button class="btn b3" onclick="delT('\${t.id}')" style="margin-left:4px">Del</button></td></tr>\`).join('');}
function openTaskModal(){editTId=null;document.getElementById('tm-title').textContent='Add Task';['tt','td','tr','tl'].forEach(i=>document.getElementById(i).value='');document.getElementById('tm').classList.add('open');}
function editT(id,t,d,r,l){editTId=id;document.getElementById('tm-title').textContent='Edit Task';document.getElementById('tt').value=t;document.getElementById('td').value=d;document.getElementById('tr').value=r;document.getElementById('tl').value=l;document.getElementById('tm').classList.add('open');}
function closeTM(){document.getElementById('tm').classList.remove('open');}
async function saveTask(){const t=document.getElementById('tt').value,d=document.getElementById('td').value,r=document.getElementById('tr').value,l=document.getElementById('tl').value;if(!t||!d||!r){toast('Fill required fields','e');return;}if(editTId){await api('/admin/tasks/'+editTId,{method:'PATCH',body:JSON.stringify({title:t,description:d,reward:parseInt(r),link:l||null})});toast('Updated!');}else{await api('/tasks',{method:'POST',body:JSON.stringify({title:t,description:d,reward:r,link:l||null})});toast('Created!');}closeTM();loadT();}
async function togT(id,a){await api('/tasks/'+id,{method:'PATCH',body:JSON.stringify({isActive:a})});toast(a?'Enabled':'Disabled');loadT();}
async function delT(id){if(!confirm('Delete this task?'))return;await api('/tasks/'+id,{method:'DELETE'});toast('Deleted','e');loadT();}
async function sendBcast(){const msg=document.getElementById('bmsg').value;if(!msg.trim()){toast('Empty message','e');return;}if(!confirm('Send to ALL users?'))return;document.getElementById('bres').textContent='Sending...';const d=await api('/broadcast',{method:'POST',body:JSON.stringify({message:msg})});document.getElementById('bres').textContent='Sent:'+d.sent+' Failed:'+d.failed;toast('Done!');}
loadStats();loadW();
</script></body></html>`;
}
