// netlify/functions/create-checkout.js
//
// يستقبل هذا الإندبوينت طلب POST من الموقع { sellerId, amount }،
// وينشئ "Checkout" عند Chargily، ويرجّع رابط الدفع (checkout_url) للمتصفح
// حتى يحوّل المستخدم إليه. مفتاح Chargily السري يبقى هنا فقط (سيرفر)
// وما يتعرّضش أبدًا للمتصفح.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { sellerId, amount } = body;

  // ---- تحقق أساسي من صحة المدخلات (نفس الحدود المستعملة فالواجهة الأمامية) ----
  if (!sellerId || typeof sellerId !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "sellerId مفقود أو غير صحيح" }) };
  }
  const numAmount = Number(amount);
  if (!numAmount || numAmount < 100 || numAmount > 500000) {
    return { statusCode: 400, body: JSON.stringify({ error: "المبلغ يجب أن يكون بين 100 و500000 د.ج" }) };
  }

  const SECRET_KEY = process.env.CHARGILY_SECRET_KEY;
  const SITE_URL = process.env.SITE_URL; // مثال: https://lacasse.netlify.app (بدون / فآخره)
  const LIVE_MODE = process.env.CHARGILY_LIVE_MODE === "true";

  if (!SECRET_KEY || !SITE_URL) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "إعداد السيرفر ناقص: تأكد من CHARGILY_SECRET_KEY و SITE_URL في متغيرات البيئة على Netlify" })
    };
  }

  // في وضع الاختبار الرابط فيه /test/ زيادة؛ في وضع الإنتاج بلاها
  const API_BASE = LIVE_MODE
    ? "https://pay.chargily.net/api/v2"
    : "https://pay.chargily.net/test/api/v2";

  try {
    const res = await fetch(`${API_BASE}/checkouts`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: numAmount,
        currency: "dzd",
        locale: "ar",
        description: `شحن رصيد La Casse — البائع ${sellerId}`,
        success_url: `${SITE_URL}/?topup=success`,
        failure_url: `${SITE_URL}/?topup=failed`,
        webhook_endpoint: `${SITE_URL}/.netlify/functions/chargily-webhook`,
        metadata: { sellerId, amount: numAmount, purpose: "wallet_topup" }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Chargily create-checkout error:", data);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: data.message || "تعذّر إنشاء عملية الدفع عند Chargily" })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ checkout_url: data.checkout_url })
    };
  } catch (e) {
    console.error("create-checkout exception:", e);
    return { statusCode: 500, body: JSON.stringify({ error: "خطأ غير متوقع فالسيرفر" }) };
  }
};
