# Loot Box Bot — Deploy on Railway

  ## 1. Firebase Setup
  1. console.firebase.google.com → New Project
  2. Left menu → Firestore Database → Create database → Production mode
  3. ⚙️ Project Settings → Service accounts → Generate new private key (download JSON)

  ## 2. Railway Setup
  1. railway.app → New Project → Deploy from GitHub → select Loot-Box
  2. **No database plugin needed** (uses Firebase)

  ## 3. Environment Variables (Railway → Variables)
  | Variable | Value |
  |---|---|
  | TELEGRAM_BOT_TOKEN | Your bot token |
  | ADMIN_SECRET | Your admin password |
  | BOT_USERNAME | Bot @username without @ |
  | FIREBASE_SERVICE_ACCOUNT | Entire JSON content from step 1.3 |

  ## 4. Webhook (after deploy)
  ```
  TELEGRAM_BOT_TOKEN=xxx node setup-webhook.js https://your-app.up.railway.app
  ```

  ## 5. Admin Panel
  https://your-app.up.railway.app/api/admin-panel
  