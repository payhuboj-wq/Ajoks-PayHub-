
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const FLUTTERWAVE_API_URL =
  "https://api.flutterwave.com/v3/payments";

const MAX_AMOUNT_NGN = 10_000_000;
const EXPECTED_ORIGIN = "https://ajoks-payhub.pages.dev";

Deno.serve(async (req: Request) => {
  const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const origin = req.headers.get("Origin") ?? "";
  const originAllowed =
    allowedOrigins.includes(origin) &&
    origin === EXPECTED_ORIGIN;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": originAllowed
      ? origin
      : "null",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  const respond = (status: number, data: object) =>
    new Response(JSON.stringify(data), { status, headers });

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  if (req.method !== "POST") {
    return respond(405, { error: "Method not allowed." });
  }

  if (!originAllowed) {
    return respond(403, { error: "Website origin not allowed." });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    );
    const flutterwaveKey = Deno.env.get(
      "FLUTTERWAVE_SECRET_KEY",
    );
    const redirectValue = Deno.env.get(
      "FLUTTERWAVE_REDIRECT_URL",
    );

    if (
      !supabaseUrl ||
      !anonKey ||
      !serviceRoleKey ||
      !flutterwaveKey ||
      !redirectValue
    ) {
      return respond(500, {
        error: "Payment server configuration is incomplete.",
      });
    }

    if (!flutterwaveKey.startsWith("FLWSECK_TEST-")) {
      return respond(500, {
        error: "This function only supports Flutterwave test mode.",
      });
    }

    let redirectUrl: URL;

    try {
      redirectUrl = new URL(redirectValue);
    } catch {
      return respond(500, {
        error: "The configured redirect URL is invalid.",
      });
    }

    if (
      redirectUrl.protocol !== "https:" ||
      redirectUrl.origin !== EXPECTED_ORIGIN ||
      redirectUrl.username ||
      redirectUrl.password
    ) {
      return respond(500, {
        error: "The redirect URL is not allowed.",
      });
    }

    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return respond(401, {
        error: "Please sign in first.",
      });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: { Authorization: authorization },
      },
    });

    const token = authorization.slice(7);
    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser(token);

    if (authError || !user || !user.email) {
      return respond(401, {
        error: "Your session is invalid. Please sign in again.",
      });
    }

    let body: { amount?: unknown };

    try {
      body = await req.json();
    } catch {
      return respond(400, {
        error: "A valid JSON request is required.",
      });
    }

    if (
      typeof body.amount !== "number" &&
      typeof body.amount !== "string"
    ) {
      return respond(400, {
        error: "Enter a valid payment amount.",
      });
    }

    const amount = Number(body.amount);

    if (
      !Number.isFinite(amount) ||
      amount < 1 ||
      amount > MAX_AMOUNT_NGN ||
      Math.round(amount * 100) !== amount * 100
    ) {
      return respond(400, {
        error: "Enter an amount between ₦1 and ₦10,000,000.",
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const txRef = `ajoks_${crypto.randomUUID()}`;

    const { data: payment, error: insertError } = await admin
      .from("payments")
      .insert({
        user_id: user.id,
        provider: "flutterwave",
        tx_ref: txRef,
        amount,
        currency: "NGN",
        status: "pending",
      })
      .select("id")
      .single();

    if (insertError || !payment) {
      console.error(
        "Could not create pending payment record:",
        insertError,
      );

      return respond(500, {
        error: "Could not create your payment record.",
      });
    }

    let checkoutResponse: Response;

    try {
      checkoutResponse = await fetch(FLUTTERWAVE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${flutterwaveKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount,
          currency: "NGN",
          redirect_url: redirectUrl.toString(),
          customer: {
            email: user.email,
          },
          customizations: {
            title: "Ajoks PayHub",
            description: "Wallet funding",
          },
        }),
      });
    } catch (error) {
      console.error("Flutterwave request failed:", error);

      return respond(502, {
        error: "Checkout could not be reached. Your payment remains pending.",
        tx_ref: txRef,
      });
    }

    let result: {
      status?: string;
      data?: { link?: string };
    };

    try {
      result = await checkoutResponse.json();
    } catch {
      return respond(502, {
        error: "Flutterwave returned an invalid response.",
        tx_ref: txRef,
      });
    }

    if (
      !checkoutResponse.ok ||
      result.status !== "success" ||
      typeof result.data?.link !== "string"
    ) {
      console.error(
        "Flutterwave checkout initialization was unsuccessful.",
      );

      return respond(502, {
        error: "Checkout could not be initialized. Contact support if needed.",
        tx_ref: txRef,
      });
    }

    let checkoutUrl: URL;

    try {
      checkoutUrl = new URL(result.data.link);
    } catch {
      return respond(502, {
        error: "Flutterwave returned an invalid checkout link.",
      });
    }

    if (
      checkoutUrl.protocol !== "https:" ||
      checkoutUrl.hostname !== "checkout.flutterwave.com"
    ) {
      return respond(502, {
        error: "Flutterwave returned an unexpected checkout address.",
      });
    }

    return respond(200, {
      checkout_url: checkoutUrl.toString(),
      tx_ref: txRef,
      status: "pending",
    });
  } catch (error) {
    console.error("Payment initialization failed:", error);

    return respond(500, {
      error: "An unexpected error occurred.",
    });
  }
});
