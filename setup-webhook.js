// node setup-webhook.js https://your-app.up.railway.app
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url   = process.argv[2];
  if (!token || !url) { console.error("Usage: TELEGRAM_BOT_TOKEN=xxx node setup-webhook.js https://your-url"); process.exit(1); }
  fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${url}/api/webhook`, allowed_updates: ["message","callback_query"] }),
  }).then(r => r.json()).then(d => {
    if (d.ok) console.log("✅ Webhook set:", url + "/api/webhook");
    else console.error("❌ Failed:", d.description);
  });