const DEFAULT_WP_BASE = "https://podl.fun";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      ctx.waitUntil(ensureTelegramWebhook(request, env));
      return json({ ok: true, service: "wctsp-independent-relay", mode: "wordpress-pull-and-telegram-webhook" });
    }

    if (request.method === "GET" && url.pathname === "/ping") {
      ctx.waitUntil(ensureTelegramWebhook(request, env));
      return json({ ok: true, pong: true, service: "wctsp-independent-relay" });
    }

    // Telegram sends bot updates here. WordPress is contacted by the Worker,
    // so the Iranian WordPress host never needs an outbound connection to us.
    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const cfg = await getConfig(env);
      if (!cfg.ok) return json(cfg, 502);
      return json({ ok: true, service: "wctsp-independent-relay", wordpress: cfg.site_url });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    await ensureTelegramWebhook(null, env);
    await processQueue(env);
  }
};

function wpBase(env) {
  return String(env.WP_BASE_URL || DEFAULT_WP_BASE).replace(/\/$/, "");
}

function secret(env) {
  return String(env.RELAY_SECRET || "");
}

async function getConfig(env) {
  const s = secret(env);
  if (!s) return { ok: false, error: "RELAY_SECRET is missing" };

  try {
    const r = await fetch(`${wpBase(env)}/wp-json/wctsp/v1/relay-config`, {
      method: "GET",
      headers: {
        "X-Relay-Secret": s,
        "Accept": "application/json",
        "Cache-Control": "no-cache"
      }
    });
    const text = await r.text();
    const data = safeJson(text);
    if (!r.ok || !data?.ok) {
      return { ok: false, error: data?.error || `WordPress config HTTP ${r.status}` };
    }
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "WordPress config request failed" };
  }
}

async function ensureTelegramWebhook(request, env) {
  const cfg = await getConfig(env);
  if (!cfg.ok || !cfg.token || !cfg.webhook_secret) return cfg;

  const origin = request ? new URL(request.url).origin : `https://${env.WORKER_HOST || "telegram-relay.pouyak6666601.workers.dev"}`;
  const webhook = `${origin}/telegram-webhook`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.token)}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        url: webhook,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
        secret_token: cfg.webhook_secret
      })
    });
    const data = safeJson(await r.text());
    if (!r.ok || !data?.ok) return { ok: false, error: data?.description || `Telegram setWebhook HTTP ${r.status}` };
    return { ok: true, webhook };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "setWebhook failed" };
  }
}

async function handleTelegramWebhook(request, env) {
  const cfg = await getConfig(env);
  if (!cfg.ok) return json(cfg, 502);

  const telegramSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!cfg.webhook_secret || telegramSecret !== cfg.webhook_secret) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  try {
    const r = await fetch(`${wpBase(env)}/wp-json/wctsp/v1/relay-update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Relay-Secret": secret(env)
      },
      body: JSON.stringify(update)
    });
    const data = safeJson(await r.text());
    if (!r.ok || !data?.ok) return json({ ok: false, error: data?.error || `WordPress update HTTP ${r.status}` }, 502);

    const commands = Array.isArray(data.commands) ? data.commands : [];
    const results = [];
    // Execute sequentially to preserve the order of bot replies.
    for (const command of commands.slice(0, 40)) {
      if (!command?.method) continue;
      const result = await telegramCall(cfg.token, command.method, command.params || {});
      results.push({ method: command.method, ok: !!result?.ok });
    }
    return json({ ok: true, commands: results.length });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Webhook relay failed" }, 502);
  }
}

async function processQueue(env) {
  const cfg = await getConfig(env);
  if (!cfg.ok || !cfg.token) return cfg;

  let data;
  try {
    const r = await fetch(`${wpBase(env)}/wp-json/wctsp/v1/relay-queue`, {
      method: "GET",
      headers: { "X-Relay-Secret": secret(env), "Accept": "application/json", "Cache-Control": "no-cache" }
    });
    data = safeJson(await r.text());
    if (!r.ok || !data?.ok) return { ok: false, error: data?.error || `Queue HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Queue fetch failed" };
  }

  const jobs = Array.isArray(data.jobs) ? data.jobs.slice(0, 10) : [];
  for (const job of jobs) {
    let result;
    try {
      result = await telegramCall(cfg.token, job.method, job.params || {});
    } catch (e) {
      result = { ok: false, description: e instanceof Error ? e.message : "Telegram request failed" };
    }

    await fetch(`${wpBase(env)}/wp-json/wctsp/v1/relay-queue`, {
      method: "POST",
      headers: { "X-Relay-Secret": secret(env), "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        id: job.id,
        status: result?.ok ? "done" : "retry",
        error: result?.ok ? "" : String(result?.description || "Telegram request failed")
      })
    });
  }

  return { ok: true, processed: jobs.length };
}

async function telegramCall(token, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(params || {})
  });
  const data = safeJson(await r.text());
  return data || { ok: false, description: `Telegram HTTP ${r.status}` };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
