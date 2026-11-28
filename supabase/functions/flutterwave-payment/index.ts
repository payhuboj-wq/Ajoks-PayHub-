import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const FLUTTERWAVE_API =
  "https://api.flutterwave.com/v3/payments";

const MAX_AMOUNT_NGN = 10_000_000;

function getAllowedOrigins(): Set<string> {
  const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "";

  return new Set(
    raw.split(",").map((value) => {
      const origin = value.trim();
      if (!origin) return "";

      const url = new URL(origin);

      if (
        url.origin !== origin ||
        url.protocol !== "https:"
      ) {
        throw new Error("Invalid origin configuration");
      }

      return origin;
    }).filter(Boolean),
  );
}

function response(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
  allowed: Set<string>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
  });

  if (origin && allowed.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  let allowed: Set<string>;

  try {
    allowed = getAllowedOrigins();
  } catch {
    return new Response("Server configuration error", {
      status: 500,
    });
  }

  const origin = req.headers.get("Origin");

  if (origin && !allowed.has(origin)) {
    return response({ error: "Origin not allowed" }, 403, null, allowed);
  }

  if (req.method === "OPTIONS") {
    const headers = new Headers({
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info",
      "Vary": "Origin",
    });

    if (origin && allowed.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
    }

    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed" }, 405, origin, allowed);
  }

  const authorization = req.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  const apiKey = req.headers.get("apikey");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  if (!match || !apiKey || !supabaseUrl) {
    return response({ error: "Authentication required" }, 401, origin, allowed);
  }

  let user;

  try {
    const supabase = createClient(supabaseUrl, apiKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data, error } = await supabase.auth.getUser(match[1]);

    if (error || !data.user?.email) {
      return response({ error: "Valid signed-in account required" }, 401, origin, allowed);
    }

    user = data.user;
  } catch {
    return response({ error: "Could not verify account" }, 503, origin, allowed);
  }

  if (!req.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return response({ error: "Expected JSON body" }, 415, origin, allowed);
  }

  let body: { amount?: unknown };

  try {
    body = await req.json();
  } catch {
    return response({ error: "Invalid request body" }, 400, origin, allowed);
  }

  const amount = body?.amount;

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 1 ||
    amount > MAX_AMOUNT_NGN ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7
  ) {
    return response({ error: "Invalid payment amount" }, 400, origin, allowed);
  }

  const secret = Deno.env.get("FLUTTERWAVE_SECRET_KEY");
  const redirectUrl = Deno.env.get("FLUTTERWAVE_REDIRECT_URL");

  if (!secret?.startsWith("FLWSECK_TEST-") || !redirectUrl) {
    return response({ error: "Test payment service not configured" }, 503, origin, allowed);
  }

  try {
    const redirect = new URL(redirectUrl);

    if (redirect.protocol !== "https:") {
      return response({ error: "Invalid redirect configuration" }, 503, origin, allowed);
    }
  } catch {
    return response({ error: "Invalid redirect configuration" }, 503, origin, allowed);
  }

  const txRef = `ajokspayhub_${crypto.randomUUID()}`;

  try {
    const result = await fetch(FLUTTERWAVE_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency: "NGN",
        redirect_url: redirectUrl,
        customer: { email: user.email },
        customizations: {
          title: "Ajoks PayHub",
          description: "Wallet funding",
        },
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!result.ok) {
      return response({ error: "Could not initialize payment" }, 502, origin, allowed);
    }

    const data = await result.json();
    const link = data?.data?.link;

    if (
      data?.status !== "success" ||
      typeof link !== "string"
    ) {
      return response({ error: "Invalid checkout response" }, 502, origin, allowed);
    }

    const checkout = new URL(link);

    if (
      checkout.protocol !== "https:" ||
      checkout.hostname !== "checkout.flutterwave.com"
    ) {
      return response({ error: "Invalid checkout link" }, 502, origin, allowed);
    }

    return response({
      checkout_url: checkout.href,
      tx_ref: txRef,
    }, 200, origin, allowed);
  } catch {
    return response({ error: "Payment service temporarily unavailable" }, 502, origin, allowed);
  }
});
