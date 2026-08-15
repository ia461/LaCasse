// netlify/functions/chargily-webhook.js
//
// Chargily يبعث طلب POST لهذا الإندبوينت مباشرة (سيرفر لسيرفر) بعد كل عملية دفع،
// بلا مرور عبر متصفح المستخدم — هذا هو المصدر الوحيد الموثوق لإضافة الرصيد فعليًا.
// نتحقق أولًا من التوقيع (signature) حتى نتأكد إن الطلب جاي من Chargily فعلًا
// ومحتواه ما تلاعبش فيه أحد، ثم نضيف الرصيد لمحفظة البائع فـ Firestore
// باستعمال Firebase Admin SDK (له صلاحية كاملة، بلا حاجة لقواعد Firestore Rules).

const crypto = require("crypto");
const admin = require("firebase-admin");

// ---------------- تهيئة Firebase Admin (مرة واحدة فقط عبر كل استدعاءات الدالة) ----------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // متغيرات البيئة تخزّن الأسطر الجديدة كـ "\n" حرفيًا، لازم نرجعها لسطر حقيقي
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    })
  });
}
const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const SECRET_KEY = process.env.CHARGILY_SECRET_KEY;
  if (!SECRET_KEY) {
    console.error("CHARGILY_SECRET_KEY غير مضبوط");
    return { statusCode: 500, body: "server misconfigured" };
  }

  // ---------------- 1) التحقق من التوقيع ----------------
  // مهم: نتحقق من التوقيع على النص الخام (raw body) بالضبط كما وصل، قبل أي JSON.parse
  const signature = event.headers["signature"] || event.headers["Signature"];
  const rawBody = event.body || "";

  if (!signature) {
    return { statusCode: 400, body: "missing signature" };
  }

  const computedSignature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(rawBody, "utf8")
    .digest("hex");

  const sigBuf = Buffer.from(signature, "utf8");
  const compBuf = Buffer.from(computedSignature, "utf8");
  const validSignature = sigBuf.length === compBuf.length && crypto.timingSafeEqual(sigBuf, compBuf);

  if (!validSignature) {
    console.warn("Chargily webhook: توقيع غير صحيح");
    return { statusCode: 403, body: "invalid signature" };
  }

  // ---------------- 2) تحليل الحدث ----------------
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "invalid JSON" };
  }

  const eventType = payload.type;
  const checkout = payload.data;

  // نهتم فقط بحدث "الدفع نجح"؛ باقي الأحداث (فشل/إلغاء/انتهاء صلاحية) نتجاهلها بأمان
  if (eventType !== "checkout.paid") {
    return { statusCode: 200, body: "ignored" };
  }

  const sellerId = checkout && checkout.metadata && checkout.metadata.sellerId;
  const amount = checkout && checkout.amount;
  const checkoutId = checkout && checkout.id;

  if (!sellerId || !amount || !checkoutId) {
    console.error("Chargily webhook: بيانات ناقصة فالحدث", payload);
    return { statusCode: 400, body: "missing data" };
  }

  // ---------------- 3) الإضافة للرصيد — بشكل idempotent ----------------
  // نستعمل معرّف الـ checkout كمعرّف مستند فـ "topups"، حتى لو Chargily
  // بعث نفس الـ webhook أكثر من مرة (وهذا وارد ويُنصح به رسميًا)، ما نزيدش
  // الرصيد إلا مرة وحدة فقط لهذا الدفع بالذات.
  const topupRef = db.collection("topups").doc("chargily_" + checkoutId);
  const sellerRef = db.collection("sellers").doc(sellerId);

  try {
    await db.runTransaction(async (tx) => {
      const topupSnap = await tx.get(topupRef);
      if (topupSnap.exists) {
        return; // هذا الحدث تعالج قبل، ما نديرو حتى حاجة (idempotent)
      }
      const sellerSnap = await tx.get(sellerRef);
      if (!sellerSnap.exists) {
        throw new Error(`Seller ${sellerId} not found`);
      }
      tx.set(topupRef, {
        sellerId,
        sellerName: sellerSnap.data().name || null,
        amount,
        ref: checkoutId,
        note: "دفع فوري عبر Chargily (EDAHABIA / CIB)",
        status: "approved",
        method: "chargily",
        date: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.update(sellerRef, {
        wallet: admin.firestore.FieldValue.increment(amount)
      });
    });

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("Chargily webhook processing error:", e);
    // نرجّع خطأ 500 حتى Chargily يعاود يبعث الحدث لاحقًا (retry) بدل ما نخسر العملية
    return { statusCode: 500, body: "processing error" };
  }
};
