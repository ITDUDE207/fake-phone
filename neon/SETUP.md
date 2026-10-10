# Neon setup (one time)

1. In the Neon Console, open your project and enable **Auth** and the **Data API**
   (set the Data API to use Neon Auth).
2. Open the **SQL Editor** and run `neon/schema.sql`.
3. Copy `.env.example` to `.env` and paste your Auth URL and Data API URL.
4. `npm install`, then `npm run tauri dev`.

If sign-up works but sign-in is refused, check the Auth settings for required email verification.
