// netlify/functions/create-checkout.js
//
// هذه الدالة تعمل على خادم Netlify (ماشي فالمتصفح)، وهي الوحيدة المخوّلة لاستعمال
// مفتاح Chargily السري (CHARGILY_SECRET_KEY) لأنه لا يجب أبدًا أن يظهر في كود الموقع
// الذي يقرأه المتصفح.
//
// متغيرات البيئة المطلوبة (تُضاف من Netlify → Site settings → Environment variables):
//   CHARGILY_SECRET_KEY  → المفتاح السري من لوحة تحكم Chargily (test_sk_... أو live_sk_...)
//   CHARGILY_MODE        → "test" أو "live" (اتركها test للتجربة قبل الانطلاق الفعلي)
//   SITE_URL             → رابط موقعك الكامل، مثال: https://meek-parfait-af61be.netlify.app

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "بيانات غير صحيحة." }) };
  }

  const sellerId = String(body.sellerId || "").trim();
  const amount = Number(body.amount);

  // تحقق أساسي من صحة المدخلات قبل مناداة Chargily
  if (!sellerId) {
    return { statusCode: 400, body: JSON.stringify({ error: "معرّف البائع مفقود، سجّل دخولك أولًا." }) };
  }
  if (!amount || !Number.isFinite(amount) || amount < 100 || amount > 500000) {
    return { statusCode: 400, body: JSON.stringify({ error: "المبلغ يجب أن يكون بين 100 و 500000 د.ج." }) };
  }

  const secretKey = process.env.CHARGILY_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "خدمة الدفع غير مهيأة بعد (CHARGILY_SECRET_KEY مفقود)." }) };
  }

  const isLive = (process.env.CHARGILY_MODE || "test") === "live";
  const apiBase = isLive
    ? "https://pay.chargily.net/api/v2"
    : "https://pay.chargily.net/test/api/v2";

  const siteUrl = process.env.SITE_URL || `https://${event.headers.host}`;

  try {
    const resp = await fetch(`${apiBase}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "dzd",
        locale: "ar",
        description: "شحن محفظة بائع — La Casse",
        success_url: `${siteUrl}/?topup=success`,
        failure_url: `${siteUrl}/?topup=failed`,
        webhook_endpoint: `${siteUrl}/.netlify/functions/chargily-webhook`,
        metadata: [{ sellerId }],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: data.message || "تعذّر إنشاء عملية الدفع عبر Chargily." }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ checkout_url: data.checkout_url }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "خطأ في الاتصال بـ Chargily: " + e.message }) };
  }
};
