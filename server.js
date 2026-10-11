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

function requireEnv(names) {
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error(`Eksik ortam değişkenleri: ${missing.join(', ')}`);
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
      'FIREBASE_SERVICE_ACCOUNT geçerli JSON değil.'
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

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      success: false,
      message: 'Render ortamına ADMIN_PASSWORD eklenmeli.'
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

function validEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

async function brevoSend(payload) {
  requireEnv(['BREVO_API_KEY', 'SENDER_EMAIL']);

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

function welcomeHtml() {
  return `<!doctype html>
<html lang="tr">
<body style="margin:0;background:#0b0c10;color:#fff;font-family:Arial,sans-serif;padding:28px">
  <div style="max-width:600px;margin:auto;background:#151922;border:1px solid #303746;border-radius:18px;overflow:hidden">
    <div style="padding:28px;text-align:center;background:#21163d">
      <div style="font-size:30px;font-weight:bold;color:#fff">
        Chatix<span style="color:#00f2fe">AI</span>
      </div>
    </div>
    <div style="padding:30px;line-height:1.7">
      <h1 style="color:#00f2fe;font-size:25px">
        ChatixAI Dünyasına Hoş Geldin! ✨
      </h1>
      <p>ChatixAI güncellemeleri ve duyurularından haberdar olmak için listeye katıldığın için teşekkür ederiz.</p>
      <p>Yeni duyuruları e-posta kutuna göndereceğiz.</p>
      <a href="https://chatixai.onrender.com"
         style="display:inline-block;margin-top:12px;background:#6f42c1;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:bold">
        ChatixAI'ı Keşfet
      </a>
      <p style="color:#9ba3b4;font-size:12px;margin-top:30px">
        © 2026 ChatixAI
      </p>
    </div>
  </div>
</body>
</html>`;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ChatixAI Mail'
  });
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const email =
      typeof req.body.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';

    if (!validEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Geçerli bir e-posta adresi girin.'
      });
    }

    requireEnv([
      'BREVO_API_KEY',
      'SENDER_EMAIL',
      'FIREBASE_SERVICE_ACCOUNT'
    ]);

    const database = initFirebase();
    const ref = database.collection('subscribers').doc(email);
    const existing = await ref.get();

    if (existing.exists) {
      return res.json({
        success: true,
        message: 'Bu e-posta adresi zaten bülten listemizde.'
      });
    }

    await ref.set({
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
          'Kaydın alındı ancak hoş geldin e-postası gönderilemedi.'
      });
    }

    res.json({
      success: true,
      message:
        'Kaydın tamamlandı! Gelen kutunu ve spam klasörünü kontrol et.'
    });
  } catch (error) {
    console.error('Abonelik hatası:', error.message);

    res.status(500).json({
      success: false,
      message: 'Kayıt sırasında sunucu hatası oluştu.'
    });
  }
});

const systemInstruction = `
Sen ChatixAI için profesyonel HTML e-posta bülteni hazırlarsın.
Yalnızca şu anahtarları içeren geçerli JSON döndür:
{"subject":"...","htmlContent":"..."}.

Markdown veya açıklama ekleme.
HTML içindeki CSS inline olmalı.
Koyu #0b0c10 zemin, #6f42c1 mor ve #00f2fe turkuaz vurgular kullan.
Mobil uyumlu e-posta tasarımı oluştur.
ChatixAI markasını ve https://chatixai.onrender.com
adresine giden bir butonu ekle.
Script, form, iframe veya javascript URL kullanma.
Telif satırı © 2026 ChatixAI olsun.
`;

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
            'Duyuru metni boş olamaz ve 6000 karakteri aşamaz.'
        });
      }

      const response = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                subject: { type: 'STRING' },
                htmlContent: { type: 'STRING' }
              },
              required: ['subject', 'htmlContent']
            }
          }
        },
        {
          params: { key: process.env.GEMINI_API_KEY },
          timeout: 60000
        }
      );

      const raw = response.data?.candidates?.[0]
        ?.content?.parts?.map(part => part.text || '')
        .join('')
        .trim();

      if (!raw) {
        throw new Error('Gemini boş yanıt döndürdü.');
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
        throw new Error('Gemini yanıt formatı geçersiz.');
      }

      const htmlContent = parsed.htmlContent
        .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
        .replace(/\s(on\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/javascript\s*:/gi, '');

      pendingEmail = {
        subject: parsed.subject.trim().slice(0, 200),
        htmlContent,
        createdAt: Date.now()
      };

      res.json({
        success: true,
        data: {
          subject: pendingEmail.subject,
          htmlContent: pendingEmail.htmlContent
        }
      });
    } catch (error) {
      console.error(
        'Taslak oluşturma hatası:',
        error.response?.data || error.message
      );

      res.status(502).json({
        success: false,
        message:
          'Taslak oluşturulamadı. Gemini API anahtarını, model erişimini ve kotanı kontrol et.'
      });
    }
  }
);

app.post(
  '/api/admin/send-bulk',
  adminAuth,
  async (_req, res) => {
    if (sendInProgress) {
      return res.status(409).json({
        success: false,
        message: 'Bir gönderim zaten devam ediyor.'
      });
    }

    if (!pendingEmail) {
      return res.status(400).json({
        success: false,
        message: 'Önce bir taslak oluşturun.'
      });
    }

    if (Date.now() - pendingEmail.createdAt > 3600000) {
      pendingEmail = null;

      return res.status(400).json({
        success: false,
        message: 'Taslak süresi doldu. Lütfen yeniden oluşturun.'
      });
    }

    sendInProgress = true;
    const draft = pendingEmail;

    try {
      requireEnv([
        'BREVO_API_KEY',
        'SENDER_EMAIL',
        'FIREBASE_SERVICE_ACCOUNT'
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
                'Gönderilemedi:',
                singleError.response?.data || singleError.message
              );
            }
          }
        }
      }

      pendingEmail = null;

      res.json({
        success: true,
        message:
          `Gönderim tamamlandı. Başarılı: ${sent}, başarısız: ${failed}.`,
        sent,
        failed,
        total: recipients.length
      });
    } catch (error) {
      console.error('Toplu gönderim hatası:', error.message);

      res.status(500).json({
        success: false,
        message: 'Toplu gönderim sırasında hata oluştu.'
      });
    } finally {
      sendInProgress = false;
    }
  }
);

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((err, _req, res, _next) => {
  console.error('Express hatası:', err.message);

  res.status(500).json({
    success: false,
    message: 'Beklenmeyen sunucu hatası.'
  });
});

process.on('unhandledRejection', reason => {
  console.error('İşlenmeyen Promise hatası:', reason);
});

process.on('uncaughtException', error => {
  console.error('Kritik sunucu hatası:', error);
  process.exit(1);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `ChatixAI Mail ${PORT} portunda çalışıyor.`
  );
});
