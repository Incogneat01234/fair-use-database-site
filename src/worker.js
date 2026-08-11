// Fair Use Database — Worker API over D1.
// Routes:
//   GET /auth/login      — redirect to Google OAuth
//   GET /auth/callback   — code exchange, user upsert, session cookie
//   GET /auth/logout     — clear session
//   GET /api/me          — session status (open)
//   GET /api/stats                                        (auth required)
//   GET /api/search?q=...&page=1                          (auth required)
//   GET /api/cases?outcome=&court_level=&factor=&...      (auth required)
//   GET /api/case/:opinionId                              (auth required)
// Everything else falls through to static assets. The HTML shell stays
// public; the data behind /api/* is what the login gate protects.

import { handleChat } from "./folsom.js";

const PAGE_SIZE = 25;

function json(data, status = 200, noStore = false) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": noStore ? "no-store" : "public, max-age=300",
    },
  });
}

/* ---------- auth ---------- */

const SESSION_COOKIE = "fud_session";
const STATE_COOKIE = "fud_oauth_state";
const SESSION_TTL = 30 * 24 * 3600; // 30 days, seconds

const encoder = new TextEncoder();

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const b64u = {
  encode(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

function hmacKey(env, usage) {
  return crypto.subtle.importKey(
    "raw", encoder.encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, [usage]
  );
}

// Session cookie: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
async function signSession(env, payload) {
  const body = b64u.encode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(env, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64u.encode(new Uint8Array(sig))}`;
}

async function readSession(env, request) {
  const raw = cookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  try {
    const key = await hmacKey(env, "verify");
    const ok = await crypto.subtle.verify(
      "HMAC", key, b64u.decode(raw.slice(dot + 1)), encoder.encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64u.decode(body)));
    if (!payload.x || payload.x < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location, extraCookies) {
  const headers = new Headers({ location });
  for (const c of extraCookies || []) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

// Funnel events (auth_start / auth_fail) log under user_id 0, the anonymous
// pre-auth pseudo-user, so attempts and failures are visible next to logins.
function logAuthEvent(env, ctx, action, detail) {
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO activity_log (user_id, ts, action, detail) VALUES (0, ?1, ?2, ?3)"
    )
      .bind(new Date().toISOString(), action, JSON.stringify(detail))
      .run()
      .catch(() => {})
  );
}

function authLogin(env, url, ctx) {
  logAuthEvent(env, ctx, "auth_start", { provider: "google" });
  const state = b64u.encode(crypto.getRandomValues(new Uint8Array(16)));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    [setCookie(STATE_COOKIE, state, 600)]
  );
}

async function authCallback(env, request, url, ctx) {
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "google", reason: oauthError });
    return new Response(
      `Google sign-in was not completed (${oauthError.replace(/[^a-z_]/g, "")}). Return to the site and try again, or use email sign-in.`,
      { status: 400 }
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookies(request)[STATE_COOKIE]) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "google", reason: "state_mismatch" });
    return new Response(
      "Sign-in failed: the browser state did not match. Return to the site and try again.",
      { status: 400 }
    );
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("token exchange failed", tokenRes.status, await tokenRes.text());
    logAuthEvent(env, ctx, "auth_fail", { provider: "google", reason: "token_exchange" });
    return new Response("Sign-in failed at the token exchange. Try again.", {
      status: 502,
    });
  }
  const tokens = await tokenRes.json();
  // The id_token arrives directly from Google's token endpoint over TLS, so
  // its claims are trusted without a separate signature check.
  const claims = JSON.parse(
    new TextDecoder().decode(b64u.decode(tokens.id_token.split(".")[1]))
  );
  if (!claims.sub || !claims.email || claims.email_verified !== true) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "google", reason: "unverified_email" });
    return new Response("Sign-in requires a Google account with a verified email address.", {
      status: 403,
    });
  }
  const cookie = await loginUser(env, {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    hd: claims.hd,
    picture: claims.picture,
    provider: "google",
  });
  // Readable by app.js so GA can record one login event per fresh sign-in.
  const evtCookie = "fud_login_evt=google; Path=/; Secure; SameSite=Lax; Max-Age=120";
  return redirect("/", [cookie, setCookie(STATE_COOKIE, "", 0), evtCookie]);
}


const MS_STATE_COOKIE = "fud_ms_state";

function msLogin(env, url, ctx) {
  logAuthEvent(env, ctx, "auth_start", { provider: "microsoft" });
  const state = b64u.encode(crypto.getRandomValues(new Uint8Array(16)));
  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/ms/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return redirect(
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`,
    [setCookie(MS_STATE_COOKIE, state, 600)]
  );
}

async function msCallback(env, request, url, ctx) {
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "microsoft", reason: oauthError });
    return new Response(
      `Microsoft sign-in was not completed (${oauthError.replace(/[^a-z_]/g, "")}). Return to the site and try again, or use email sign-in.`,
      { status: 400 }
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookies(request)[MS_STATE_COOKIE]) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "microsoft", reason: "state_mismatch" });
    return new Response(
      "Sign-in failed: the browser state did not match. Return to the site and try again.",
      { status: 400 }
    );
  }
  const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/ms/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("ms token exchange failed", tokenRes.status, await tokenRes.text());
    logAuthEvent(env, ctx, "auth_fail", { provider: "microsoft", reason: "token_exchange" });
    return new Response("Sign-in failed at the token exchange. Try again.", {
      status: 502,
    });
  }
  const tokens = await tokenRes.json();
  // id_token comes straight from Microsoft's token endpoint over TLS; claims
  // are trusted without a separate signature check (same posture as Google).
  const claims = JSON.parse(
    new TextDecoder().decode(b64u.decode(tokens.id_token.split(".")[1]))
  );
  const email = (claims.email || claims.preferred_username || "").toLowerCase();
  if (!claims.sub || !EMAIL_RE.test(email)) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "microsoft", reason: "no_email_claim" });
    return new Response(
      "Microsoft sign-in did not supply an email address. Use email sign-in instead.",
      { status: 403 }
    );
  }
  const cookie = await loginUser(env, {
    sub: `ms:${claims.sub}`,
    email,
    name: claims.name,
    hd: emailDomain(email),
    provider: "microsoft",
  });
  const evtCookie = "fud_login_evt=microsoft; Path=/; Secure; SameSite=Lax; Max-Age=120";
  return redirect("/", [cookie, setCookie(MS_STATE_COOKIE, "", 0), evtCookie]);
}

/* ---------- email sign-in (code + direct link in one email) ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_TTL_MIN = 15;
const MAX_STARTS_PER_HOUR = 6;
const MAX_CODE_ATTEMPTS = 5;

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Rejection-sampled so every digit is uniform.
function randDigits(n) {
  const out = [];
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 250 && out.length < n) out.push(b % 10);
    }
  }
  return out.join("");
}

async function sendSigninEmail(env, email, code, link) {
  const text =
    `Your sign-in code is ${code}. Enter it on the sign-in page, ` +
    `or use this link to sign in directly:\n\n${link}\n\n` +
    `The code and link expire in ${CODE_TTL_MIN} minutes. ` +
    `If you did not request this, ignore this email.`;
  const html =
    `<p>Your sign-in code is <strong style="font-size:1.3em">${code}</strong>.</p>` +
    `<p>Enter it on the sign-in page, or <a href="${link}">sign in directly with this link</a>.</p>` +
    `<p>The code and link expire in ${CODE_TTL_MIN} minutes. ` +
    `If you did not request this, ignore this email.</p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "The Fair Use Database <signin@thefairusedatabase.com>",
      to: [email],
      subject: `Your Fair Use Database sign-in code: ${code}`,
      text,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend ${res.status}: ${await res.text()}`);
  }
}

/* ---------- contact form ---------- */

const CONTACT_TO = "tomreich@siu.edu";
const CONTACT_MAX_PER_HOUR = 5;

async function apiContact(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad request" }, 400, true);
  }
  // Honeypot: real users never fill this hidden field.
  if (body.website) return json({ ok: true }, 200, true);
  const name = String(body.name || "").trim().slice(0, 200);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const message = String(body.message || "").trim();
  if (!name || !EMAIL_RE.test(email) || message.length < 10 ||
      message.length > 5000) {
    return json(
      { error: "please provide your name, a valid email address, and a message of at least 10 characters" },
      400, true);
  }
  const ipHash = await sha256hex(
    request.headers.get("cf-connecting-ip") || "unknown");
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contact_messages WHERE ip_hash = ?1 AND created_at > ?2"
  )
    .bind(ipHash, hourAgo)
    .first();
  if (recent.n >= CONTACT_MAX_PER_HOUR) {
    return json({ error: "too many messages; please try again later" }, 429, true);
  }
  await env.DB.prepare(
    `INSERT INTO contact_messages (created_at, ip_hash, name, email, message)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(new Date().toISOString(), ipHash, name, email, message)
    .run();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "The Fair Use Database <contact@thefairusedatabase.com>",
      to: [CONTACT_TO],
      reply_to: [email],
      subject: `Fair Use Database contact from ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
    }),
  });
  if (!res.ok) {
    console.error(`resend contact ${res.status}: ${await res.text()}`);
    return json({ error: "could not send the message; please try again" }, 502, true);
  }
  return json({ ok: true }, 200, true);
}

// Shared login tail for every provider: upsert the user row, log the login,
// mint the session cookie. Matches by provider subject first, then by email
// address, so one person signing in through Google and through email stays
// one row (both paths prove control of the same verified address).
async function loginUser(env, { sub, email, name, hd, picture, provider }) {
  const now = new Date().toISOString();
  let user = await env.DB.prepare(
    `SELECT user_id, email, name FROM users
     WHERE google_sub = ?1 OR email = ?2
     ORDER BY (google_sub = ?1) DESC LIMIT 1`
  )
    .bind(sub, email)
    .first();
  if (user) {
    await env.DB.prepare(
      `UPDATE users SET
         email = ?2, name = COALESCE(?3, name), hd = COALESCE(?4, hd),
         picture = COALESCE(?5, picture), last_seen = ?6,
         login_count = login_count + 1
       WHERE user_id = ?1`
    )
      .bind(user.user_id, email, name || null, hd || null, picture || null, now)
      .run();
    user = { ...user, email, name: name || user.name };
  } else {
    user = await env.DB.prepare(
      `INSERT INTO users (google_sub, email, name, hd, picture, first_seen, last_seen, provider)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
       RETURNING user_id, email, name`
    )
      .bind(sub, email, name || null, hd || null, picture || null, now, provider)
      .first();
  }
  await env.DB.prepare(
    "INSERT INTO activity_log (user_id, ts, action, detail) VALUES (?1, ?2, 'login', ?3)"
  )
    .bind(user.user_id, now, JSON.stringify({ provider }))
    .run();
  const session = await signSession(env, {
    u: user.user_id,
    e: user.email,
    n: user.name || "",
    x: Math.floor(Date.now() / 1000) + SESSION_TTL,
  });
  return setCookie(SESSION_COOKIE, session, SESSION_TTL);
}

function emailDomain(email) {
  return email.split("@")[1] || null;
}

async function emailStart(env, request, url, ctx) {
  logAuthEvent(env, ctx, "auth_start", { provider: "email" });
  if (!env.RESEND_API_KEY)
    return json({ error: "email sign-in not enabled" }, 503, true);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad request" }, 400, true);
  }
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "invalid email" }, 400, true);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM email_verifications WHERE email = ?1 AND created_at > ?2"
  )
    .bind(email, hourAgo)
    .first();
  if (recent.n >= MAX_STARTS_PER_HOUR)
    return json({ error: "too many codes requested; try again later" }, 429, true);
  const code = randDigits(6);
  const token = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO email_verifications (email, code_hash, token_hash, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(email, await sha256hex(code), await sha256hex(token),
          now.toISOString(),
          new Date(now.getTime() + CODE_TTL_MIN * 60_000).toISOString())
    .run();
  try {
    await sendSigninEmail(env, email, code,
                          `${url.origin}/auth/email/verify?token=${token}`);
  } catch (err) {
    console.error(err);
    // Remove the row: a failed send must never supersede an older working
    // code or count against the requester's rate limit.
    await env.DB.prepare(
      "DELETE FROM email_verifications WHERE token_hash = ?1"
    ).bind(await sha256hex(token)).run().catch(() => {});
    logAuthEvent(env, ctx, "auth_fail", { provider: "email", reason: "send_failed" });
    return json({ error: "could not send the email; try again" }, 502, true);
  }
  return json({ ok: true }, 200, true);
}

async function emailCheck(env, request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad request" }, 400, true);
  }
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").replace(/\D/g, "");
  if (!EMAIL_RE.test(email) || code.length !== 6)
    return json({ error: "invalid code" }, 400, true);
  // Any unexpired code for this address works, as many times as needed within
  // its TTL: email delivery can reorder messages, and scanners consuming links
  // or sessions must never kill a code. Wrong-guess budget is shared across
  // all active codes for the address.
  const active = (await env.DB.prepare(
    `SELECT verification_id, code_hash, attempts FROM email_verifications
     WHERE email = ?1 AND expires_at > ?2
     ORDER BY verification_id DESC LIMIT 6`
  )
    .bind(email, new Date().toISOString())
    .all()).results;
  if (!active.length) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "email", reason: "code_expired_or_used" });
    return json({ error: "code expired; request a new one" }, 400, true);
  }
  const totalAttempts = active.reduce((n, r) => n + r.attempts, 0);
  if (totalAttempts >= MAX_CODE_ATTEMPTS) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "email", reason: "attempt_limit" });
    return json({ error: "too many attempts; request a new code" }, 429, true);
  }
  const codeHash = await sha256hex(code);
  if (!active.some((r) => r.code_hash === codeHash)) {
    await env.DB.prepare(
      "UPDATE email_verifications SET attempts = attempts + 1 WHERE verification_id = ?1"
    )
      .bind(active[0].verification_id)
      .run();
    logAuthEvent(env, ctx, "auth_fail", { provider: "email", reason: "wrong_code" });
    return json({ error: "wrong code" }, 401, true);
  }
  const cookie = await loginUser(env, {
    sub: `email:${email}`,
    email,
    hd: emailDomain(email),
    provider: "email",
  });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": cookie,
    },
  });
}

// GET: render a confirmation page that immediately POSTs the token back.
// Email security scanners (Outlook SafeLinks etc.) prefetch GET links, which
// used to consume the token before the user could click it. Nothing is
// consumed on GET; only the POST from the interstitial signs the user in.
function emailVerifyInterstitial(url) {
  const token = url.searchParams.get("token") || "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token))
    return new Response("Missing or malformed token.", { status: 400 });
  const esc = token;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Signing in · The Fair Use Database</title>
<style>body{font-family:Georgia,serif;background:#f6f2e8;color:#1f1c17;display:grid;place-items:center;min-height:100vh;margin:0}
main{text-align:center;padding:2rem}h1{font-size:1.25rem;font-weight:600}
button{font:inherit;padding:0.6rem 1.4rem;background:#1e3350;color:#fff;border:0;border-radius:6px;cursor:pointer}</style></head>
<body><main><h1>The Fair Use Database</h1>
<form method="POST" action="/auth/email/verify" id="f">
<input type="hidden" name="token" value="${esc}">
<p>Press the button to finish signing in.</p>
<button type="submit">Continue to sign in</button>
</form></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

async function emailVerifyLink(env, request, ctx) {
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") || "");
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  if (!token)
    return new Response("Missing token.", { status: 400 });
  // Single conditional UPDATE claims the link atomically; concurrent POSTs
  // cannot both redeem it.
  const row = await env.DB.prepare(
    `UPDATE email_verifications SET link_consumed = 1
     WHERE token_hash = ?1 AND link_consumed = 0 AND expires_at > ?2
     RETURNING verification_id, email`
  )
    .bind(await sha256hex(token), new Date().toISOString())
    .first();
  if (!row) {
    logAuthEvent(env, ctx, "auth_fail", { provider: "email", reason: "link_expired_or_used" });
    return new Response(
      "This sign-in link has expired or was already used. You can still sign in by typing the 6-digit code from the same email into the site.",
      { status: 400 }
    );
  }
  let cookie;
  try {
    cookie = await loginUser(env, {
      sub: `email:${row.email}`,
      email: row.email,
      hd: emailDomain(row.email),
      provider: "email",
    });
  } catch (err) {
    console.error("link claim succeeded but login failed", err);
    logAuthEvent(env, ctx, "auth_fail", { provider: "email", reason: "link_login_failed" });
    return new Response(
      "Something went wrong finishing sign-in. Type the 6-digit code from the same email into the site instead.",
      { status: 500 }
    );
  }
  return redirect("/", [
    cookie,
    "fud_login_evt=email; Path=/; Secure; SameSite=Lax; Max-Age=120",
  ]);
}

// Fire-and-forget activity trail: one row per user action (search, browse,
// case view, login). /api/case-search and /api/stats are not logged — the
// first duplicates the search the user just ran, the second fires on every
// page load.
function logActivity(env, ctx, userId, action, detail) {
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO activity_log (user_id, ts, action, detail) VALUES (?1, ?2, ?3, ?4)"
    )
      .bind(userId, new Date().toISOString(), action,
            detail ? JSON.stringify(detail) : null)
      .run()
  );
}

async function apiMe(env, request, ctx) {
  const emailSignin = Boolean(env.RESEND_API_KEY);
  const session = await readSession(env, request);
  if (!session) return json({ authenticated: false, emailSignin }, 200, true);
  ctx.waitUntil(
    env.DB.prepare("UPDATE users SET last_seen = ?1 WHERE user_id = ?2")
      .bind(new Date().toISOString(), session.u)
      .run()
  );
  return json(
    { authenticated: true, email: session.e, name: session.n, emailSignin },
    200,
    true
  );
}

// Build a safe FTS5 MATCH expression. Double-quoted spans become phrase
// terms; everything else splits on whitespace. Each term is re-quoted so no
// FTS5 syntax reaches the parser.
function ftsQuery(raw) {
  const terms = [];
  const scanner = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = scanner.exec(raw)) && terms.length < 12) {
    const text = (m[1] !== undefined ? m[1] : m[2]).replace(/"/g, "").trim();
    if (text) terms.push(`"${text}"`);
  }
  if (!terms.length) return null;
  return terms.join(" AND ");
}

function pageParam(url) {
  const p = parseInt(url.searchParams.get("page") || "1", 10);
  return Number.isFinite(p) && p > 0 ? p : 1;
}

async function apiStats(env) {
  const [release, funnel, opinions, units, quotes, outcomes, directions, courts] =
    await Promise.all([
      env.DB.prepare(
        `SELECT release_id, released_date, coverage_end, description
         FROM release ORDER BY released_date DESC LIMIT 1`
      ).first(),
      env.DB.prepare(
        "SELECT cohort_class, COUNT(*) AS n FROM screening_ledger GROUP BY cohort_class"
      ).all(),
      env.DB.prepare(
        "SELECT cohort_class, COUNT(*) AS n FROM opinions GROUP BY cohort_class"
      ).all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM units").first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n
         FROM evidence ev JOIN extractions x ON x.extraction_id = ev.extraction_id
         WHERE x.is_selected = 1`
      ).first(),
      env.DB.prepare(
        `SELECT h.outcome, COUNT(*) AS n
         FROM holdings h JOIN extractions e ON e.extraction_id = h.extraction_id
         WHERE e.is_selected = 1 GROUP BY h.outcome ORDER BY n DESC`
      ).all(),
      env.DB.prepare(
        `SELECT f.factor_number, f.direction, COUNT(*) AS n
         FROM factors f JOIN extractions e ON e.extraction_id = f.extraction_id
         WHERE e.is_selected = 1 GROUP BY f.factor_number, f.direction`
      ).all(),
      env.DB.prepare(
        "SELECT court_level, COUNT(*) AS n FROM opinion_metadata GROUP BY court_level ORDER BY n DESC"
      ).all(),
    ]);
  return json({
    release,
    screeningFunnel: funnel.results,
    opinionsByCohort: opinions.results,
    unitCount: units.n,
    quoteCount: quotes.n,
    outcomes: outcomes.results,
    factorDirections: directions.results,
    courtLevels: courts.results,
  });
}

const VOICES = new Set([
  "deciding_court_controlling", "deciding_court_majority",
  "deciding_court_dissent", "lower_court", "party", "expert_or_witness",
  "unknown",
]);

const CIRCUITS = new Set([
  "ca1", "ca2", "ca3", "ca4", "ca5", "ca6", "ca7", "ca8", "ca9", "ca10",
  "ca11", "cadc", "cafc", "scotus", "fedcl",
]);

const DIRECTIONS = new Set([
  "favors_fair_use", "disfavors_fair_use", "neutral", "mixed", "unclear",
  "not_analyzed",
]);
const CLASS_TYPES = { work_type: "workTypes", use_type: "useTypes", tech: "technologyContexts" };
// Classification/posture values are enum slugs; binding prevents injection,
// the shape check just rejects garbage before it reaches the query planner.
const SLUG_RE = /^[a-z0-9_]{2,64}$/;

async function apiSearch(env, url) {
  const raw = (url.searchParams.get("q") || "").trim();
  const match = ftsQuery(raw);
  if (!match) return json({ query: raw, results: [], total: 0 });
  const page = pageParam(url);
  const offset = (page - 1) * PAGE_SIZE;
  // Optional filters. Each adds one clause; binds sit after the MATCH term
  // (?1), so a value's placeholder number is its fbinds position plus one.
  const filters = [];
  const fbinds = [];
  const bindPos = (v) => {
    fbinds.push(v);
    return fbinds.length + 1;
  };
  const voice = url.searchParams.get("voice");
  if (VOICES.has(voice)) filters.push(`ev.voice = ?${bindPos(voice)}`);
  const outcome = url.searchParams.get("outcome");
  if (["fair_use", "not_fair_use", "unresolved", "not_reached"].includes(outcome)) {
    filters.push(`h.outcome = ?${bindPos(outcome)}`);
  }
  const court = url.searchParams.get("court");
  if (["supreme", "circuit", "district"].includes(court)) {
    filters.push(`m.court_level = ?${bindPos(court)}`);
  }
  const circuit = url.searchParams.get("circuit");
  if (CIRCUITS.has(circuit)) filters.push(`m.circuit_id = ?${bindPos(circuit)}`);
  const courtExact = url.searchParams.get("court_exact");
  if (courtExact && courtExact.length <= 40) {
    filters.push(`o.court_abbrev = ?${bindPos(courtExact)}`);
  }
  const dateFrom = url.searchParams.get("date_from");
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(dateFrom || "")) {
    filters.push(
      `o.decision_date >= ?${bindPos(dateFrom.length === 4 ? dateFrom + "-01-01" : dateFrom)}`
    );
  }
  const dateTo = url.searchParams.get("date_to");
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(dateTo || "")) {
    filters.push(
      `o.decision_date <= ?${bindPos(dateTo.length === 4 ? dateTo + "-12-31" : dateTo)}`
    );
  }
  const pub = url.searchParams.get("pub");
  if (["published", "unpublished", "slip", "unknown"].includes(pub)) {
    filters.push(`o.publication_status = ?${bindPos(pub)}`);
  }
  const posture = url.searchParams.get("posture");
  if (posture && SLUG_RE.test(posture)) {
    filters.push(
      `EXISTS (SELECT 1 FROM opinion_postures p
        WHERE p.opinion_id = o.opinion_id AND p.posture = ?${bindPos(posture)})`
    );
  }
  for (const [param, classType] of Object.entries(CLASS_TYPES)) {
    const v = url.searchParams.get(param);
    if (v && SLUG_RE.test(v)) {
      filters.push(
        `EXISTS (SELECT 1 FROM opinion_classifications c
          WHERE c.opinion_id = o.opinion_id
            AND c.class_type = '${classType}' AND c.value = ?${bindPos(v)})`
      );
    }
  }
  if (url.searchParams.get("merits") === "yes") {
    filters.push(`h.final_merits_status = 'yes'`);
  }
  const factor = url.searchParams.get("factor");
  const direction = url.searchParams.get("direction");
  if (["1", "2", "3", "4"].includes(factor) && DIRECTIONS.has(direction)) {
    // Factor + direction: case-level coding on this extraction.
    filters.push(
      `EXISTS (SELECT 1 FROM factors fx
        WHERE fx.extraction_id = x.extraction_id
          AND fx.factor_number = ?${bindPos(Number(factor))}
          AND fx.direction = ?${bindPos(direction)})`
    );
  } else if (["1", "2", "3", "4"].includes(factor)) {
    // Factor alone: the quote itself grounds that factor.
    // evidence.field_paths uses zero-indexed factors[N] path segments
    filters.push(`ev.field_paths LIKE '%factors[${Number(factor) - 1}]%'`);
  }
  const filterClause = filters.length ? "AND " + filters.join(" AND ") : "";
  const hits = await env.DB.prepare(
    `SELECT ev.evidence_row_id, ev.quote, ev.page, ev.section, ev.voice,
            ev.supports, ev.field_paths,
            u.unit_id, u.copyrighted_work_label, u.challenged_use_label,
            o.opinion_id, o.case_name, o.citation, o.court, o.court_abbrev,
            o.decision_date, h.outcome,
            (SELECT GROUP_CONCAT(f.factor_number || ':' || f.direction)
             FROM factors f WHERE f.extraction_id = x.extraction_id)
              AS factors_agg
     FROM evidence_fts
     JOIN evidence ev ON ev.evidence_row_id = evidence_fts.rowid
     JOIN extractions x ON x.extraction_id = ev.extraction_id
     JOIN units u ON u.unit_id = x.unit_id
     JOIN opinions o ON o.opinion_id = u.opinion_id
     LEFT JOIN opinion_metadata m ON m.opinion_id = o.opinion_id
     LEFT JOIN holdings h ON h.extraction_id = x.extraction_id
     WHERE evidence_fts MATCH ?1 AND x.is_selected = 1 ${filterClause}
     ORDER BY bm25(evidence_fts)
     LIMIT ?${fbinds.length + 2} OFFSET ?${fbinds.length + 3}`
  )
    .bind(match, ...fbinds, PAGE_SIZE, offset)
    .all();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM evidence_fts
     JOIN evidence ev ON ev.evidence_row_id = evidence_fts.rowid
     JOIN extractions x ON x.extraction_id = ev.extraction_id
     JOIN units u ON u.unit_id = x.unit_id
     JOIN opinions o ON o.opinion_id = u.opinion_id
     LEFT JOIN opinion_metadata m ON m.opinion_id = o.opinion_id
     LEFT JOIN holdings h ON h.extraction_id = x.extraction_id
     WHERE evidence_fts MATCH ?1 AND x.is_selected = 1 ${filterClause}`
  )
    .bind(match, ...fbinds)
    .first();
  return json({
    query: raw,
    page,
    pageSize: PAGE_SIZE,
    total: total.n,
    results: hits.results,
  });
}

// Facet inventory for the advanced-filters card: distinct values with counts
// for every dimension the card exposes. Values are release-stable, so the
// front end caches the response for the session.
async function apiFacets(env) {
  const [courts, postures, classes] = await Promise.all([
    env.DB.prepare(
      `SELECT o.court_abbrev AS value, m.court_level, COUNT(*) AS n
       FROM opinions o
       LEFT JOIN opinion_metadata m ON m.opinion_id = o.opinion_id
       WHERE o.court_abbrev IS NOT NULL AND o.court_abbrev != ''
       GROUP BY o.court_abbrev, m.court_level
       ORDER BY CASE m.court_level WHEN 'supreme' THEN 0 WHEN 'circuit' THEN 1 ELSE 2 END,
                n DESC`
    ).all(),
    env.DB.prepare(
      `SELECT posture AS value, COUNT(*) AS n
       FROM opinion_postures GROUP BY posture ORDER BY n DESC`
    ).all(),
    env.DB.prepare(
      `SELECT class_type, value, COUNT(*) AS n
       FROM opinion_classifications
       WHERE value NOT IN ('unknown', 'none')
       GROUP BY class_type, value ORDER BY class_type, n DESC`
    ).all(),
  ]);
  const byType = { workTypes: [], useTypes: [], technologyContexts: [] };
  for (const r of classes.results) {
    (byType[r.class_type] ||= []).push({ value: r.value, n: r.n });
  }
  return json({
    courts: courts.results,
    postures: postures.results,
    workTypes: byType.workTypes,
    useTypes: byType.useTypes,
    technologyContexts: byType.technologyContexts,
  });
}

// Case-name lookup behind the "Cases" strip: prefix match on caption,
// exact caption first, then higher courts, published, newest.
async function apiCaseSearch(env, url) {
  let raw = (url.searchParams.get("q") || "").trim();
  raw = raw.replace(/^"+|"+$/g, "").replace(/\s+/g, " ");
  raw = raw.replace(/\b(?:versus|vs\.?)(?=\s)/gi, "v.");
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (alnum.length < 4) return json({ query: raw, results: [] });
  const rows = await env.DB.prepare(
    `SELECT o.opinion_id, o.case_name, o.citation, o.court_abbrev,
            o.decision_date, o.publication_status, m.court_level
     FROM opinions o
     LEFT JOIN opinion_metadata m ON m.opinion_id = o.opinion_id
     WHERE o.case_name LIKE ?1
     ORDER BY (LOWER(o.case_name) = LOWER(?2)) DESC,
              CASE m.court_level WHEN 'supreme' THEN 0 WHEN 'circuit' THEN 1 ELSE 2 END,
              (o.publication_status = 'published') DESC,
              o.decision_date DESC
     LIMIT 5`
  )
    .bind(raw.replace(/[%_]/g, " ") + "%", raw)
    .all();
  return json({ query: raw, results: rows.results });
}

// Case-level listing behind the same filter grammar as /api/search, so the
// front end can drive both result shapes from one filter band. Accepts the
// legacy court_level/factor/direction params (factor-block pivot links) plus
// the full search set and an optional q matched against the case name.
async function apiCases(env, url) {
  const page = pageParam(url);
  const offset = (page - 1) * PAGE_SIZE;
  const where = ["x.is_selected = 1"];
  const binds = [];
  const bindPos = (v) => {
    binds.push(v);
    return binds.length;
  };
  const q = (url.searchParams.get("q") || "").trim();
  if (q && q.length <= 200) {
    // LIKE wildcards in user input would silently broaden the match.
    where.push(`o.case_name LIKE ?${bindPos("%" + q.replace(/[%_]/g, " ") + "%")}`);
  }
  const outcome = url.searchParams.get("outcome");
  if (["fair_use", "not_fair_use", "unresolved", "not_reached"].includes(outcome)) {
    where.push(`h.outcome = ?${bindPos(outcome)}`);
  }
  const courtLevel =
    url.searchParams.get("court_level") || url.searchParams.get("court");
  if (["supreme", "circuit", "district"].includes(courtLevel)) {
    where.push(`m.court_level = ?${bindPos(courtLevel)}`);
  }
  const circuit = url.searchParams.get("circuit");
  if (circuit && CIRCUITS.has(circuit)) {
    where.push(`m.circuit_id = ?${bindPos(circuit)}`);
  }
  const courtExact = url.searchParams.get("court_exact");
  if (courtExact && courtExact.length <= 40) {
    where.push(`o.court_abbrev = ?${bindPos(courtExact)}`);
  }
  const dateFrom = url.searchParams.get("date_from");
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(dateFrom || "")) {
    where.push(
      `o.decision_date >= ?${bindPos(dateFrom.length === 4 ? dateFrom + "-01-01" : dateFrom)}`
    );
  }
  const dateTo = url.searchParams.get("date_to");
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(dateTo || "")) {
    where.push(
      `o.decision_date <= ?${bindPos(dateTo.length === 4 ? dateTo + "-12-31" : dateTo)}`
    );
  }
  const pub = url.searchParams.get("pub");
  if (["published", "unpublished", "slip", "unknown"].includes(pub)) {
    where.push(`o.publication_status = ?${bindPos(pub)}`);
  }
  const posture = url.searchParams.get("posture");
  if (posture && SLUG_RE.test(posture)) {
    where.push(
      `EXISTS (SELECT 1 FROM opinion_postures p
        WHERE p.opinion_id = o.opinion_id AND p.posture = ?${bindPos(posture)})`
    );
  }
  for (const [param, classType] of Object.entries(CLASS_TYPES)) {
    const v = url.searchParams.get(param);
    if (v && SLUG_RE.test(v)) {
      where.push(
        `EXISTS (SELECT 1 FROM opinion_classifications c
          WHERE c.opinion_id = o.opinion_id
            AND c.class_type = '${classType}' AND c.value = ?${bindPos(v)})`
      );
    }
  }
  if (url.searchParams.get("merits") === "yes") {
    where.push(`h.final_merits_status = 'yes'`);
  }
  const voice = url.searchParams.get("voice");
  if (VOICES.has(voice)) {
    where.push(
      `EXISTS (SELECT 1 FROM evidence ev
        WHERE ev.extraction_id = x.extraction_id AND ev.voice = ?${bindPos(voice)})`
    );
  }
  // factor and direction filter independently: factor alone means "the court
  // analyzed factor N", direction alone means "any factor leaned this way",
  // together they pin direction to that factor.
  const factor = parseInt(url.searchParams.get("factor") || "", 10);
  const direction = url.searchParams.get("direction");
  const factorConds = [];
  if (Number.isFinite(factor)) {
    factorConds.push(`f.factor_number = ?${bindPos(factor)}`);
  }
  if (direction && DIRECTIONS.has(direction)) {
    factorConds.push(`f.direction = ?${bindPos(direction)}`);
  }
  if (factorConds.length) {
    where.push(
      `EXISTS (SELECT 1 FROM factors f
               WHERE f.extraction_id = x.extraction_id
                 AND ${factorConds.join(" AND ")})`
    );
  }
  const base = `
     FROM units u
     JOIN extractions x ON x.unit_id = u.unit_id
     JOIN opinions o ON o.opinion_id = u.opinion_id
     LEFT JOIN holdings h ON h.extraction_id = x.extraction_id
     LEFT JOIN opinion_metadata m ON m.opinion_id = o.opinion_id
     WHERE ${where.join(" AND ")}`;
  const rows = await env.DB.prepare(
    `SELECT o.opinion_id, o.case_name, o.citation, o.court, o.court_abbrev,
            o.decision_date, o.cohort_class, m.court_level, m.circuit_id,
            COUNT(DISTINCT u.unit_id) AS unit_count,
            GROUP_CONCAT(DISTINCT h.outcome) AS outcomes
      ${base}
     GROUP BY o.opinion_id
     ORDER BY o.decision_date DESC
     LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  )
    .bind(...binds, PAGE_SIZE, offset)
    .all();
  const total = await env.DB.prepare(
    `SELECT COUNT(DISTINCT o.opinion_id) AS n ${base}`
  )
    .bind(...binds)
    .first();
  return json({
    page,
    pageSize: PAGE_SIZE,
    total: total.n,
    results: rows.results,
  });
}

async function apiCase(env, opinionId) {
  const opinion = await env.DB.prepare(
    `SELECT o.*, m.court_level, m.circuit_id, m.opinion_type, m.en_banc,
            m.judges, m.opinion_authors, m.jury_involved, m.appellate_review,
            m.standard_of_review, m.fair_use_resolved_at_stage,
            m.disposition_labels
     FROM opinions o
     LEFT JOIN opinion_metadata m ON m.opinion_id = o.opinion_id
     WHERE o.opinion_id = ?1`
  )
    .bind(opinionId)
    .first();
  if (!opinion) return json({ error: "not found" }, 404);
  const [postures, motions, classifications, units] = await Promise.all([
    env.DB.prepare(
      "SELECT posture FROM opinion_postures WHERE opinion_id = ?1"
    )
      .bind(opinionId)
      .all(),
    env.DB.prepare(
      "SELECT posture, result, moving_party FROM motion_outcomes WHERE opinion_id = ?1"
    )
      .bind(opinionId)
      .all(),
    env.DB.prepare(
      "SELECT class_type, value FROM opinion_classifications WHERE opinion_id = ?1"
    )
      .bind(opinionId)
      .all(),
    env.DB.prepare(
      `SELECT u.unit_id, u.unit_number, u.copyrighted_work_label,
              u.challenged_use_label, u.scope_note, u.provisional,
              x.extraction_id, h.outcome, h.scope, h.controlling_status,
              h.final_merits_status
       FROM units u
       LEFT JOIN extractions x ON x.unit_id = u.unit_id AND x.is_selected = 1
       LEFT JOIN holdings h ON h.extraction_id = x.extraction_id
       WHERE u.opinion_id = ?1 ORDER BY u.unit_number`
    )
      .bind(opinionId)
      .all(),
  ]);
  const hasExtractions = units.results.some((u) => u.extraction_id != null);
  let factors = [];
  let components = [];
  let evidence = [];
  // Bind the opinion id once and join down to selected extractions instead of
  // binding every extraction/factor id: a case can carry over 100 units
  // (OP000944 has 118), and D1 caps a statement at 100 bound variables.
  const selExtractions = `SELECT x.extraction_id FROM extractions x
    JOIN units su ON su.unit_id = x.unit_id
    WHERE su.opinion_id = ?1 AND x.is_selected = 1`;
  if (hasExtractions) {
    factors = (
      await env.DB.prepare(
        `SELECT extraction_id, factor_row_id, factor_number, canonical_name,
                analyzed, direction, directional_score, stated_weight, summary
         FROM factors WHERE extraction_id IN (${selExtractions})
         ORDER BY factor_number`
      )
        .bind(opinionId)
        .all()
    ).results;
    if (factors.length) {
      components = (
        await env.DB.prepare(
          `SELECT c.factor_row_id, c.component_code, c.polarity, c.note
           FROM components c
           JOIN factors f ON f.factor_row_id = c.factor_row_id
           WHERE f.extraction_id IN (${selExtractions})`
        )
          .bind(opinionId)
          .all()
      ).results;
    }
    evidence = (
      await env.DB.prepare(
        `SELECT extraction_id, evidence_id, quote, page, section, voice,
                supports, field_paths
         FROM evidence WHERE extraction_id IN (${selExtractions})
         ORDER BY page`
      )
        .bind(opinionId)
        .all()
    ).results;
  }
  return json({
    opinion,
    postures: postures.results,
    motionOutcomes: motions.results,
    classifications: classifications.results,
    units: units.results,
    factors,
    components,
    evidence,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/auth/login") return authLogin(env, url, ctx);
      if (path === "/auth/ms/login") return msLogin(env, url, ctx);
      if (path === "/auth/ms/callback") return await msCallback(env, request, url, ctx);
      if (path === "/auth/callback") return await authCallback(env, request, url, ctx);
      if (path === "/auth/logout")
        return redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);
      if (path === "/auth/email/start" && request.method === "POST")
        return await emailStart(env, request, url, ctx);
      if (path === "/auth/email/check" && request.method === "POST")
        return await emailCheck(env, request, ctx);
      if (path === "/auth/email/verify" && request.method === "POST")
        return await emailVerifyLink(env, request, ctx);
      if (path === "/auth/email/verify")
        return emailVerifyInterstitial(url);
      if (path === "/api/contact" && request.method === "POST")
        return await apiContact(env, request);
      if (path === "/api/me") return await apiMe(env, request, ctx);
      if (path.startsWith("/api/")) {
        const session = await readSession(env, request);
        if (!session) return json({ error: "auth_required" }, 401, true);
        if (path === "/api/stats") return await apiStats(env);
        if (path === "/api/chat" && request.method === "POST")
          return await handleChat(env, ctx, request, session);
        if (path === "/api/search") {
          logActivity(env, ctx, session.u, "search", {
            q: url.searchParams.get("q") || "",
            page: url.searchParams.get("page") || "1",
            ...(url.searchParams.get("voice")
              ? { voice: url.searchParams.get("voice") }
              : {}),
          });
          return await apiSearch(env, url);
        }
        if (path === "/api/case-search") return await apiCaseSearch(env, url);
        if (path === "/api/facets") return await apiFacets(env);
        if (path === "/api/cases") {
          logActivity(env, ctx, session.u, "browse",
                      Object.fromEntries(url.searchParams));
          return await apiCases(env, url);
        }
        // Saved chats: list, load, delete. Writes happen inside /api/chat.
        if (path === "/api/chats" && request.method === "GET") {
          const rows = await env.DB.prepare(
            `SELECT conversation_id, title, updated FROM chat_conversations
             WHERE user_id = ?1 ORDER BY updated DESC LIMIT 50`
          ).bind(session.u).all();
          return json({ chats: rows.results }, 200, true);
        }
        const chatMatch = path.match(/^\/api\/chats\/(\d+)$/);
        if (chatMatch) {
          const cid = Number(chatMatch[1]);
          const conv = await env.DB.prepare(
            "SELECT conversation_id, title FROM chat_conversations WHERE conversation_id = ?1 AND user_id = ?2"
          ).bind(cid, session.u).first();
          if (!conv) return json({ error: "not found" }, 404, true);
          if (request.method === "DELETE") {
            await env.DB.prepare(
              "DELETE FROM chat_messages WHERE conversation_id = ?1").bind(cid).run();
            await env.DB.prepare(
              "DELETE FROM chat_conversations WHERE conversation_id = ?1").bind(cid).run();
            return json({ ok: true }, 200, true);
          }
          if (request.method !== "GET")
            return json({ error: "method not allowed" }, 405, true);
          // Newest 200 messages, oldest-first for display: a long thread must
          // show its tail, not its head.
          const msgs = await env.DB.prepare(
            `SELECT role, content, manifest, cards FROM (
               SELECT message_id, role, content, manifest, cards FROM chat_messages
               WHERE conversation_id = ?1 ORDER BY message_id DESC LIMIT 200
             ) ORDER BY message_id ASC`
          ).bind(cid).all();
          return json({ conversation: conv, messages: msgs.results }, 200, true);
        }
        // My Cases: persistent, user-scoped folders of saved cases.
        if (path === "/api/folders" && request.method === "GET") {
          const rows = await env.DB.prepare(
            `SELECT f.folder_id, f.name, f.created, COUNT(i.opinion_id) AS case_count
             FROM case_folders f
             LEFT JOIN case_folder_items i ON i.folder_id = f.folder_id
             WHERE f.user_id = ?1 GROUP BY f.folder_id ORDER BY f.created`
          )
            .bind(session.u)
            .all();
          return json({ folders: rows.results }, 200, true);
        }
        if (path === "/api/folders" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const name = String(body.name || "").trim().slice(0, 60);
          if (!name) return json({ error: "name required" }, 400, true);
          const count = await env.DB.prepare(
            "SELECT COUNT(*) c FROM case_folders WHERE user_id = ?1"
          )
            .bind(session.u)
            .first();
          if (count.c >= 50) return json({ error: "folder limit reached" }, 400, true);
          try {
            const row = await env.DB.prepare(
              `INSERT INTO case_folders (user_id, name, created)
               VALUES (?1, ?2, ?3) RETURNING folder_id, name, created`
            )
              .bind(session.u, name, Math.floor(Date.now() / 1000))
              .first();
            logActivity(env, ctx, session.u, "folder_create", { name });
            return json({ folder: row }, 200, true);
          } catch {
            return json({ error: "a folder with that name already exists" }, 409, true);
          }
        }
        const folderMatch = path.match(/^\/api\/folders\/(\d+)$/);
        const folderItemMatch = path.match(
          /^\/api\/folders\/(\d+)\/items(?:\/(OP\d{6}))?$/
        );
        if (folderMatch || folderItemMatch) {
          const fid = Number((folderMatch || folderItemMatch)[1]);
          const owned = await env.DB.prepare(
            "SELECT folder_id, name, created FROM case_folders WHERE folder_id = ?1 AND user_id = ?2"
          )
            .bind(fid, session.u)
            .first();
          if (!owned) return json({ error: "not found" }, 404, true);
          if (folderMatch && request.method === "GET") {
            const rows = await env.DB.prepare(
              `SELECT i.opinion_id, i.added, o.case_name, o.citation,
                      o.court_abbrev, o.decision_date
               FROM case_folder_items i
               JOIN opinions o ON o.opinion_id = i.opinion_id
               WHERE i.folder_id = ?1 ORDER BY i.added DESC`
            )
              .bind(fid)
              .all();
            return json({ folder: owned, cases: rows.results }, 200, true);
          }
          if (folderMatch && request.method === "DELETE") {
            await env.DB.prepare(
              "DELETE FROM case_folder_items WHERE folder_id = ?1"
            )
              .bind(fid)
              .run();
            await env.DB.prepare(
              "DELETE FROM case_folders WHERE folder_id = ?1"
            )
              .bind(fid)
              .run();
            return json({ ok: true }, 200, true);
          }
          if (folderItemMatch && request.method === "POST") {
            const body = await request.json().catch(() => ({}));
            const oid = String(body.opinion_id || "");
            if (!/^OP\d{6}$/.test(oid))
              return json({ error: "bad opinion_id" }, 400, true);
            await env.DB.prepare(
              "INSERT OR IGNORE INTO case_folder_items (folder_id, opinion_id, added) VALUES (?1, ?2, ?3)"
            )
              .bind(fid, oid, Math.floor(Date.now() / 1000))
              .run();
            return json({ ok: true }, 200, true);
          }
          if (folderItemMatch && folderItemMatch[2] && request.method === "DELETE") {
            await env.DB.prepare(
              "DELETE FROM case_folder_items WHERE folder_id = ?1 AND opinion_id = ?2"
            )
              .bind(fid, folderItemMatch[2])
              .run();
            return json({ ok: true }, 200, true);
          }
          return json({ error: "unknown route" }, 404, true);
        }
        const pdfMatch = path.match(/^\/api\/opinion-pdf\/(OP\d{6})$/);
        if (pdfMatch) {
          const obj = await env.OPINIONS.get(`${pdfMatch[1]}.pdf`);
          if (!obj) return json({ error: "not found" }, 404);
          return new Response(obj.body, {
            headers: {
              "content-type": "application/pdf",
              "content-length": String(obj.size),
              "cache-control": "private, max-age=3600",
              "content-disposition": `inline; filename="${pdfMatch[1]}.pdf"`,
            },
          });
        }
        const caseMatch = path.match(/^\/api\/case\/(OP\d{6})$/);
        if (caseMatch) {
          logActivity(env, ctx, session.u, "case_view",
                      { opinion_id: caseMatch[1] });
          return await apiCase(env, caseMatch[1]);
        }
        return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
