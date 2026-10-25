// AnimeGate Telegram downloader: Cloudflare Worker
// Usage: https://<name>.<you>.workers.dev/?id=<message_id>
//   &json=1    return the raw API response instead of redirecting
//   &stream=1  redirect to the stream URL instead of the download URL

const CHANNEL = "animegate_archive";
const BASE = "https://telegramdownloader.net";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Per-isolate cache. Token TTL is 600s, so refresh a bit early.
let session = null; // { cookie, token, expires }

function parseCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(";")[0]).filter(Boolean);
}

async function newSession() {
  // 1. Load the homepage to pick up cf_clearance (and any other cookies)
  const home = await fetch(BASE + "/", {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  if (home.headers.get("cf-mitigated") === "challenge") {
    throw new Error(
      "Site served a JS challenge; a Worker can't solve it. Use a headless browser or a manually supplied cf_clearance."
    );
  }

  const cookies = parseCookies(home);
  const cookieHeader = cookies.join("; ");
  if (!cookies.some((c) => c.startsWith("cf_clearance="))) {
    console.warn("No cf_clearance in Set-Cookie; continuing with:", cookieHeader || "(none)");
  }

  // 2. Token endpoint: must look like a same-origin fetch()/XHR call
  const tokRes = await fetch(BASE + "/proxy.php?action=token", {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: BASE + "/",
      Origin: BASE,
      Cookie: cookieHeader,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  });

  if (!tokRes.ok) throw new Error(`Token request failed: HTTP ${tokRes.status}`);
  const tok = await tokRes.json();
  if (!tok.token) throw new Error("Token response had no token: " + JSON.stringify(tok));

  // Merge any cookies the token endpoint set
  const extra = parseCookies(tokRes);
  const merged = [...cookies, ...extra].join("; ");

  return {
    cookie: merged,
    token: tok.token,
    expires: Date.now() + Math.max(((tok.ttl ?? 600) - 30), 30) * 1000,
  };
}

async function getSession(force = false) {
  if (force || !session || Date.now() >= session.expires) {
    session = await newSession();
  }
  return session;
}

async function resolve(tgLink, s) {
  const form = new FormData();
  form.append("telegram_link", tgLink);
  form.append("rt", s.token);
  form.append("hp", "");

  const res = await fetch(BASE + "/proxy.php", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Referer: BASE + "/",
      Origin: BASE,
      Cookie: s.cookie,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    body: form, // boundary + content-type set automatically
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id || !/^\d+$/.test(id)) {
      return Response.json(
        { error: "Missing or invalid ?id= (numeric message id required)" },
        { status: 400 }
      );
    }

    const tgLink = `https://t.me/${CHANNEL}/${id}`;

    try {
      let json = await resolve(tgLink, await getSession());

      // Token expired / rejected: refresh session once and retry
      if (!json?.success || json?.data?.data?.status !== "success") {
        json = await resolve(tgLink, await getSession(true));
      }

      const inner = json?.data?.data;
      if (!json?.success || inner?.status !== "success") {
        return Response.json({ error: "Upstream failed", upstream: json }, { status: 502 });
      }

      if (url.searchParams.get("json") === "1") {
        return Response.json(inner);
      }

      const target = url.searchParams.get("stream") === "1" ? inner.stream : inner.link;
      if (!target) {
        return Response.json({ error: "No link in response", upstream: inner }, { status: 502 });
      }

      return Response.redirect(target, 302);
    } catch (err) {
      return Response.json({ error: String(err.message ?? err) }, { status: 500 });
    }
  },
};