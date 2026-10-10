# Neon setup (one time)

1. In the Neon Console, open your project and enable **Auth** and the **Data API**
   (set the Data API to use Neon Auth).
2. Open the **SQL Editor** and run `neon/schema.sql`.
3. Copy `.env.example` to `.env` and paste your Auth URL and Data API URL.
4. `npm install`, then `npm run tauri dev`.

If sign-up works but sign-in is refused, check the Auth settings for required email verification.

## App Store (optional)

1. In the SQL Editor run `neon/store.sql` (after `neon/schema.sql`).
2. Sign in on the phone, open Settings and copy your **Account ID**.
3. Make yourself an admin (you can approve or reject apps):

       insert into public.admins (user_id) values ('<your account id>');

   Reopen the App Store: a **Review** tab appears. If it doesn't, the ID doesn't match what the database sees
   as you; run `select auth.user_id();` while signed in through the Data API and use that value instead.
4. Everyone else can submit apps (5 per hour, 30 stored per person) and download approved ones.
