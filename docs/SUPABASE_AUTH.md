# QueryVault authentication setup

## 1. Make the confirmation link reachable

The browser now sends Supabase a canonical redirect based on `VITE_APP_URL`.
Use the deployed QueryVault URL in production. For phone testing, use the
computer's LAN address, not `localhost`:

```dotenv
VITE_APP_URL=http://192.168.1.25:8080
```

Replace the address and port with the machine running the dev server. Start the
dev server on `0.0.0.0`, allow the port through the local firewall, and open the
LAN URL from the phone first to verify it is reachable.

In Supabase Dashboard → **Authentication → URL Configuration**, add the exact
redirect URLs for the environment:

- `https://your-queryvault-domain.example/chat`
- `https://your-queryvault-domain.example/auth`
- `http://192.168.1.25:8080/chat` (phone testing)
- `http://192.168.1.25:8080/auth` (phone testing)

The project uses `/chat` after signup and `/auth` after password reset. The
confirmation flow is handled by Supabase's browser session callback, so no
secret or service-role key belongs in the frontend.

## 2. Brand the email as QueryVault

The sender name is not controlled by `supabase.auth.signUp()`. Configure it in
Supabase:

1. Go to **Authentication → Email Templates** and select **Confirm signup**.
2. Set the subject to `Confirm your QueryVault account`.
3. Paste the HTML from `supabase/templates/confirmation.html` into the body.
4. Go to **Authentication → SMTP Settings** and use a verified sender/display
   name of `QueryVault` (for example, `no-reply@your-queryvault-domain.example`).

Without custom SMTP, Supabase may continue to display its default sender name or
apply provider-level sender branding even when the template itself says
QueryVault. The template controls the visible email content; SMTP controls the
sender identity and deliverability.

After changing the template or sender, send a new signup email. Existing emails
keep their original redirect URL and content.
