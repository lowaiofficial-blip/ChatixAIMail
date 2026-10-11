
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let db = null;
let pendingEmail = null;
let sendInProgress = false;

// Firebase bağlantısı
function requireEnv(names) {
  const missing = names.filter(name => !process.env[name]);

  if (missing.length) {
    throw new Error(
      `Eksik environment değişkenleri: ${missing.join(', ')}`
    );
  }
}

function initFirebase() {
  if (db) return db;

  requireEnv(['FIREBASE_SERVICE_ACCOUNT']);

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } catch {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT geçerli JSON formatında değil.'
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();

  return db;
}

// Yönetici API güvenliği
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      success: false,
      message: 'ADMIN_PASSWORD environment değişkeni ayarlanmamış.'
    });
  }

  const provided = Buffer.from(
    req.get('x-admin-password') || ''
  );

  const expected = Buffer.from(ADMIN_PASSWORD);

  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return res.status(401).json({
      success: false,
      message: 'Yönetici parolası hatalı.'
    });
  }

  next();
}

// E-posta doğrulaması
function validEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

// Brevo HTTP API
async function brevoSend(payload) {
  requireEnv([
    'BREVO_API_KEY',
    'SENDER_EMAIL'
  ]);

  return axios.post(
    'https://api.brevo.com/v3/smtp/email',
    payload,
    {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      timeout: 30000
    }
  );
}

// Hoş geldin e-postası
function welcomeHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:25px;background:#0b0c10;font-family:Arial,sans-serif;color:#fff">
  <div style="max-width:600px;margin:auto;background:#151922;border:1px solid #303746;border-radius:18px;overflow:hidden">
    <div style="padding:30px;text-align:center;background:#21163d">
      <div style="font-size:30px;font-weight:bold;color:#fff">
        Chatix<span style="color:#00f2fe">AI</span>
      </div>
    </div>
    <div style="padding:30px;line-height:1.8">
      <h1 style="color:#00f2fe;font-size:25px">
        ChatixAI Dünyasına Hoş Geldin! ✨
      </h1>
      <p>ChatixAI güncellemelerinden ve yeniliklerinden haberdar olmak için listemize katıldığın için teşekkür ederiz.</p>
      <p>Yeni duyurularımızı e-posta kutuna göndereceğiz.</p>
      <a href="https://chatixai.onrender.com"
        style="display:inline-block;margin-top:12px;padding:14px 22px;border-radius:9px;background:#6f42c1;color:#fff;text-decoration:none;font-weight:bold">
        ChatixAI'ı Keşfet
      </a>
      <p style="margin-top:30px;color:#929bad;font-size:12px">
        © 2026 ChatixAI
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Sağlık kontrolü
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ChatixAI Mail'
  });
});

// Ana sayfa
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Abonelik kaydı
app.post('/api/subscribe', async (req, res) => {
  try {
    const email =
      typeof req.body.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';

    if (!validEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Lütfen geçerli bir e-posta adresi gir.'
      });
    }

    requireEnv([
      'FIREBASE_SERVICE_ACCOUNT',
      'BREVO_API_KEY',
      'SENDER_EMAIL'
    ]);

    const database = initFirebase();

    const subscriberRef = database
      .collection('subscribers')
      .doc(email);

    const existing = await subscriberRef.get();

    if (existing.exists) {
      return res.json({
        success: true,
        message: 'Bu e-posta adresi zaten bülten listemizde.'
      });
    }

    await subscriberRef.set({
      email,
      subscribedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      source: 'landing-page'
    });

    try {
      await brevoSend({
        sender: {
          name: 'ChatixAI',
          email: process.env.SENDER_EMAIL
        },
        to: [{ email }],
        subject: 'ChatixAI Dünyasına Hoş Geldin! ✨',
        htmlContent: welcomeHtml()
      });
    } catch (mailError) {
      console.error(
        'Hoş geldin e-postası gönderilemedi:',
        mailError.response?.data || mailError.message
      );

      return res.status(202).json({
        success: true,
        message:
          'Kaydın alındı. Hoş geldin e-postası şu anda gönderilemedi.'
      });
    }

    return res.json({
      success: true,
      message:
        'Kaydın başarıyla tamamlandı! Gelen kutunu ve spam klasörünü kontrol et.'
    });
  } catch (error) {
    console.error('Abonelik hatası:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Kayıt sırasında sunucu hatası oluştu.'
    });
  }
});

// Gemini sistem talimatı
const systemInstruction = `
Sen ChatixAI markası için profesyonel e-posta bültenleri hazırlarsın.

Yanıtın yalnızca şu alanları içeren geçerli JSON olmalıdır:
{
  "subject": "E-posta konu başlığı",
  "htmlContent": "Tam HTML e-posta içeriği"
}

Markdown kod blokları veya açıklama ekleme.

Tasarım kuralları:
- Koyu arka plan: #0b0c10
- Kart arka planı: #151922
- Mor vurgu: #6f42c1
- Neon turkuaz: #00f2fe
- CSS stilleri mümkün olduğunca inline olmalı.
- Mobil cihazlarla uyumlu e-posta tasarımı oluştur.
- Profesyonel başlıklar, okunabilir metinler ve buton kullan.
- ChatixAI markasını göster.
- https://chatixai.onrender.com adresine giden bir buton ekle.
- Script, iframe, form ve JavaScript URL kullanma.
- E-posta içeriğinde kullanıcı tarafından verilen duyuruyu esas al.
- Olmayan özellikler veya doğrulanmamış iddialar uydurma.
- Alt bilgiye © 2026 ChatixAI ekle.

Çıktıda yalnızca JSON döndür.
`;

// HTML üzerinde temel güvenlik kontrolleri
function sanitizeEmailHtml(html) {
  return html
    .replace(
      /<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi,
      ''
    )
    .replace(
      /<\s*(iframe|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      ''
    )
    .replace(
      /\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      ''
    )
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '');
}

// Gemini ile bülten taslağı oluştur
app.post(
  '/api/admin/generate-email',
  adminAuth,
  async (req, res) => {
    try {
      requireEnv(['GEMINI_API_KEY']);

      const prompt =
        typeof req.body.prompt === 'string'
          ? req.body.prompt.trim()
          : '';

      if (!prompt || prompt.length > 6000) {
        return res.status(400).json({
          success: false,
          message:
            'Duyuru boş olamaz ve en fazla 6000 karakter olabilir.'
        });
      }

      // Güncellenmiş Gemini model adı
      const response = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        {
          systemInstruction: {
            parts: [
              { text: systemInstruction }
            ]
          },
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                subject: {
                  type: 'STRING'
                },
                htmlContent: {
                  type: 'STRING'
                }
              },
              required: [
                'subject',
                'htmlContent'
              ]
            }
          }
        },
        {
          params: {
            key: process.env.GEMINI_API_KEY
          },
          timeout: 60000
        }
      );

      const raw = response.data
        ?.candidates?.[0]
        ?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();

      if (!raw) {
        const reason =
          response.data?.candidates?.[0]?.finishReason;

        throw new Error(
          `Gemini boş yanıt döndürdü. Durum: ${reason || 'Bilinmiyor'}`
        );
      }

      const parsed = JSON.parse(
        raw
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/, '')
      );

      if (
        typeof parsed.subject !== 'string' ||
        typeof parsed.htmlContent !== 'string' ||
        !parsed.subject.trim() ||
        !parsed.htmlContent.trim()
      ) {
        throw new Error(
          'Gemini yanıtı beklenen JSON formatında değil.'
        );
      }

      const htmlContent = sanitizeEmailHtml(
        parsed.htmlContent
      );

      pendingEmail = {
        subject: parsed.subject.trim().slice(0, 200),
        htmlContent,
        createdAt: Date.now()
      };

      return res.json({
        success: true,
        data: {
          subject: pendingEmail.subject,
          htmlContent: pendingEmail.htmlContent
        }
      });
    } catch (error) {
      console.error(
        'Gemini taslak hatası:',
        error.response?.data || error.message
      );

      const status = error.response?.status;

      return res.status(
        status === 429 ? 429 :
        status === 401 || status === 403 ? status :
        status === 404 ? 502 :
        502
      ).json({
        success: false,
        message:
          status === 404
            ? 'Gemini modeli bulunamadı veya API erişimine açık değil. Model adını ve Gemini API desteğini kontrol et.'
            : status === 429
              ? 'Gemini istek sınırına ulaşıldı. Biraz sonra tekrar dene.'
              : 'E-posta taslağı oluşturulamadı. Render loglarını kontrol et.'
      });
    }
  }
);

// Bülteni tüm abonelere gönder
app.post(
  '/api/admin/send-bulk',
  adminAuth,
  async (_req, res) => {
    if (sendInProgress) {
      return res.status(409).json({
        success: false,
        message: 'Başka bir toplu gönderim devam ediyor.'
      });
    }

    if (!pendingEmail) {
      return res.status(400).json({
        success: false,
        message: 'Önce bir e-posta taslağı oluşturmalısın.'
      });
    }

    if (Date.now() - pendingEmail.createdAt > 3600000) {
      pendingEmail = null;

      return res.status(400).json({
        success: false,
        message:
          'Taslağın süresi doldu. Lütfen yeni taslak oluştur.'
      });
    }

    sendInProgress = true;

    const draft = pendingEmail;

    try {
      requireEnv([
        'FIREBASE_SERVICE_ACCOUNT',
        'BREVO_API_KEY',
        'SENDER_EMAIL'
      ]);

      const snapshot = await initFirebase()
        .collection('subscribers')
        .get();

      const recipients = [
        ...new Set(
          snapshot.docs
            .map(doc =>
              String(doc.data().email || doc.id)
                .trim()
                .toLowerCase()
            )
            .filter(validEmail)
        )
      ];

      if (!recipients.length) {
        return res.status(400).json({
          success: false,
          message: 'Gönderilecek abone bulunamadı.'
        });
      }

      let sent = 0;
      let failed = 0;

      // Brevo messageVersions ile alıcıları ayrı tut.
      // Her alıcı kendi e-posta adresini görür.
      for (let i = 0; i < recipients.length; i += 1000) {
        const chunk = recipients.slice(i, i + 1000);

        try {
          await brevoSend({
            sender: {
              name: 'ChatixAI',
              email: process.env.SENDER_EMAIL
            },
            subject: draft.subject,
            htmlContent: draft.htmlContent,
            messageVersions: chunk.map(email => ({
              to: [{ email }]
            }))
          });

          sent += chunk.length;
        } catch (chunkError) {
          console.error(
            'Toplu gönderim hatası:',
            chunkError.response?.data || chunkError.message
          );

          // Toplu istek başarısız olursa alıcıları
          // tek tek deneyerek sonucu takip et.
          for (const email of chunk) {
            try {
              await brevoSend({
                sender: {
                  name: 'ChatixAI',
                  email: process.env.SENDER_EMAIL
                },
                to: [{ email }],
                subject: draft.subject,
                htmlContent: draft.htmlContent
              });

              sent++;
            } catch (singleError) {
              failed++;

              console.error(
                `E-posta gönderilemedi (${email}):`,
                singleError.response?.data ||
                  singleError.message
              );
            }
          }
        }
      }

      // Gönderim tamamlandığında taslağı kaldır.
      pendingEmail = null;

      return res.json({
        success: true,
        message:
          `Gönderim tamamlandı. Başarılı: ${sent}, başarısız: ${failed}.`,
        sent,
        failed,
        total: recipients.length
      });
    } catch (error) {
      console.error(
        'Toplu gönderim hatası:',
        error.response?.data || error.message
      );

      return res.status(500).json({
        success: false,
        message:
          'Toplu gönderim sırasında hata oluştu. Render loglarını kontrol et.'
      });
    } finally {
      sendInProgress = false;
    }
  }
);

// Admin paneli
app.get('/admin', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'admin.html')
  );
});

// JSON formatı bozuk istekler ve diğer Express hataları
app.use((err, _req, res, _next) => {
  console.error('Express hatası:', err.message);

  if (res.headersSent) return;

  res.status(
    err instanceof SyntaxError && 'body' in err
      ? 400
      : 500
  ).json({
    success: false,
    message:
      err instanceof SyntaxError && 'body' in err
        ? 'Geçersiz JSON isteği.'
        : 'Beklenmeyen sunucu hatası.'
  });
});

// Başlat
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `ChatixAI Mail çalışıyor. Port: ${PORT}`
  );
});

// Kritik süreç hatalarında güvenli yeniden başlatma için
// Render'ın süreç yöneticisine çıkış kodu bildir.
process.on('unhandledRejection', reason => {
  console.error('İşlenmeyen Promise hatası:', reason);
});

process.on('uncaughtException', error => {
  console.error('Kritik sunucu hatası:', error);
  process.exit(1);
});
