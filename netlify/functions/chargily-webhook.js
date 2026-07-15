// netlify/functions/chargily-webhook.js
//
// Chargily ينادي هذه الدالة تلقائيًا بعد كل عملية دفع (ناجحة أو فاشلة).
// نتحقق أولًا من التوقيع (signature) للتأكد أن الطلب جاء فعلًا من Chargily
// وليس من شخص يحاول تزوير عملية شحن، ثم نضيف الرصيد للبائع مباشرة فـ Firestore
// باستعمال صلاحيات المسؤول (Firebase Admin SDK)، والتي تتجاوز Security Rules العادية.
//
// متغيرات البيئة المطلوبة:
//   CHARGILY_SECRET_KEY        → نفس المفتاح المستعمل فـ create-checkout.js
//   FIREBASE_SERVICE_ACCOUNT_KEY → محتوى ملف JSON لحساب خدمة Firebase (انظر التعليمات أسفله)
//
// كيفاش تجيب FIREBASE_SERVICE_ACCOUNT_KEY:
//   Firebase Console → إعدادات المشروع (⚙️) → Service accounts → Generate new private key
//   يُنزَّل ملف JSON، افتحه وانسخ محتواه كاملًا (سطر واحد) وضعه كقيمة لهذا المتغير فـ Netlify.

const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  });
}
const db = admin.firestore();

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const secretKey = process.env.CHARGILY_SECRET_KEY;
  const signature = event.headers["signature"] || event.headers["Signature"];
  const rawBody = event.body || "";

  if (!secretKey) {
    return { statusCode: 500, body: "Missing CHARGILY_SECRET_KEY" };
  }
  if (!signature) {
    return { statusCode: 400, body: "Missing signature header" };
  }

  // نحسب التوقيع بنفس الطريقة اللي يحسبها Chargily، ونقارنه بأمان (بدون تسريب توقيت المقارنة)
  const computed = crypto.createHmac("sha256", secretKey).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature);
  const compBuf = Buffer.from(computed);
  const isValid = sigBuf.length === compBuf.length && crypto.timingSafeEqual(sigBuf, compBuf);

  if (!isValid) {
    return { statusCode: 403, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // نهتم فقط بحدث "الدفع نجح"، أي حدث آخر (فشل، إلغاء...) نتجاهله بأمان
  if (payload.type !== "checkout.paid") {
    return { statusCode: 200, body: "ignored (not checkout.paid)" };
  }

  const checkout = payload.data || {};
  const amount = Number(checkout.amount);
  const md = checkout.metadata;
  const sellerId = Array.isArray(md) ? (md[0] && md[0].sellerId) : (md && md.sellerId);

  if (!sellerId || !amount) {
    return { statusCode: 200, body: "ignored (missing sellerId/amount in metadata)" };
  }

  try {
    // نستعمل معرّف عملية الدفع نفسه كمعرّف مستند topups، حتى لو أعاد Chargily
    // إرسال نفس الويبهوك أكثر من مرة (شيء وارد)، ما نزيدوش الرصيد مرتين
    const topupRef = db.collection("topups").doc(String(checkout.id));
    const existing = await topupRef.get();
    if (existing.exists) {
      return { statusCode: 200, body: "already processed" };
    }

    await topupRef.set({
      amount,
      sellerId,
      source: "chargily",
      status: "approved",
      ref: checkout.id,
      note: "دفع فوري بالبطاقة عبر Chargily",
      date: new Date().toLocaleString("ar-DZ"),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("sellers").doc(String(sellerId)).update({
      wallet: admin.firestore.FieldValue.increment(amount),
    });

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    return { statusCode: 500, body: "Firestore error: " + e.message };
  }
};
