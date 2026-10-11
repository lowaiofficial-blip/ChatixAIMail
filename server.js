const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Firebase Başlatma (Firebase Admin SDK)
// Kendi serviceAccount.json dosyanın yolunu veya yapılandırmanı buraya eklemiştim
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(require('./serviceAccountKey.json'))
    });
}
const db = admin.firestore();

// 2. Brevo SMTP Konfigürasyonu
const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
        user: process.env.BREVO_USER, // Brevo kullanıcı adın / e-postan
        pass: process.env.BREVO_PASS  // Brevo SMTP şifren
    }
});

// 3. AI System Instruction - ChatGPT Bülten Tarzı, Logo ve Mail Bağlantısı Entegre Edilmiş Hali
const systemInstruction = `
Sen ChatixAI için e-posta bültenleri oluşturan profesyonel bir yapay zeka asistanısın. 
Görevin, sana verilen metinden yola çıkarak OpenAI (ChatGPT) bülten tarzına benzer; son derece şık, koyu temalı (#0b0c10 arka plan, #1f2833 footer, beyaz metinler, #00f2fe vurgu renkleri), responsive, üst kısımda "Chatix" (beyaz) ve "AI" (turkuaz #00f2fe) logosu barındıran, ortada büyük dikkat çekici başlıklar ve net paragraflar içeren, ana yönlendirme butonları "https://chatixai.onrender.com" adresine giderken, en alt footer alanında telif yılı 2026 ve yanında küçük mavi bir link şeklinde "Abone ol" (tıklandığında doğrudan mail uygulamasını açıp "chatixai.business@outlook.com" adresine abone olma talebi maili hazırlayan \`mailto:chatixai.business@outlook.com?subject=Abone%20Olmak%20İstiyorum\` bağlantısı olan) metni barındıran inline CSS'li HTML bir e-posta taslağı oluşturmaktır.

ÖNEMLİ KURALLAR:
1. Ana buton ve yönlendirme linkleri için kesinlikle "https://chatixai.onrender.com" adresini kullan.
2. Footer kısmındaki "Abone ol" linki için kesinlikle \`mailto:chatixai.business@outlook.com?subject=ChatixAI%20Abone%20Olmak%20İstiyorum\` linkini kullan.
3. Mailin en üst kısmına şık logo kutusu yerleştir: "Chatix" saf beyaz (#ffffff), "AI" ise turkuaz (#00f2fe) olsun.
4. Telif veya alt bilgi (footer) alanında yılı kesinlikle "2026" olarak yaz (Asla 2025 yazma).

ÇIKTI FORMATI ZORUNLULUĞU:
Yalnızca ve yalnızca aşağıdaki JSON formatında yanıt ver. Markdown kod blokları (\`\`\`json vb.), hiçbir ek açıklama veya ön metin EKLEME.

{
  "subject": "E-posta Konu Başlığı (Emoji içerebilir)",
  "htmlContent": "<div style=\\"...\\">Tüm HTML Kodları Inline CSS Ile Burada</div>"
}
`;

// 4. Bülten Oluşturma ve Firebase'deki Abonelere Gönderme Rotası
app.post('/api/send-newsletter', async (req, res) => {
    try {
        const { promptText } = req.body;
        if (!promptText) {
            return res.status(400).json({ success: false, error: "Prompt metni eksik." });
        }
        
        // Gemini API Çağrısı (Model Fallback zinciri ile)
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        let responseText = "";
        const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-3.5-flash'];
        
        for (const modelName of models) {
            try {
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: promptText,
                    config: {
                        systemInstruction: systemInstruction,
                        responseMimeType: "application/json"
                    }
                });
                responseText = response.text;
                if (responseText) break;
            } catch (err) {
                console.log(`${modelName} başarısız oldu, sonrakine geçiliyor...`);
            }
        }

        if (!responseText) {
            throw new Error("Hiçbir Gemini modelinden yanıt alınamadı.");
        }

        const emailData = JSON.parse(responseText);

        // Firebase Firestore'dan aboneleri çek
        const subscribersSnapshot = await db.collection('subscribers').get();
        const subscribers = [];
        subscribersSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.email) {
                subscribers.push(data.email);
            }
        });

        if (subscribers.length === 0) {
            return res.status(400).json({ success: false, error: "Firebase'de kayıtlı abone bulunamadı." });
        }

        // Brevo SMTP ile toplu e-posta gönderimi
        let sentCount = 0;
        for (const email of subscribers) {
            try {
                await transporter.sendMail({
                    from: '"ChatixAI" <chatixai.business@outlook.com>',
                    to: email,
                    subject: emailData.subject,
                    html: emailData.htmlContent
                });
                sentCount++;
            } catch (mailErr) {
                console.error(`E-posta gönderilemedi (${email}):`, mailErr.message);
            }
        }
        
        res.json({ 
            success: true, 
            message: `Bülten başarıyla oluşturuldu ve ${sentCount} aboneye gönderildi!`, 
            subject: emailData.subject 
        });

    } catch (error) {
        console.error("Sunucu Hatası:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ChatixAI sunucusu ${PORT} portunda ayakta! 🚀`);
});
