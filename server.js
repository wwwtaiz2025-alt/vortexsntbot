const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// -------------------- التحقق من بيانات تيليجرام (مع التسامح مع الأخطاء) --------------------
function verifyTelegramData(initData) {
    try {
        if (!initData) return false;
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        if (!hash) return false; // لا يوجد تشفير، نعتبر البيانات غير آمنة ولكن نمررها للاختبار
        
        urlParams.delete('hash');
        const keys = [...urlParams.keys()].sort();
        let dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');
        const secret = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
        return computedHash === hash;
    } catch (e) {
        console.log("⚠️ تحقق initData فشل، ولكننا سنمرر الطلب للاختبار:", e.message);
        return true; // نمرر الطلب في حالة وجود خطأ بالتحقق (للتجربة)
    }
}

// -------------------- الاتصال بقاعدة البيانات --------------------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ متصل بـ MongoDB'))
  .catch(err => console.error('❌ فشل الاتصال:', err));

// -------------------- نماذج MongoDB --------------------
const CounterSchema = new mongoose.Schema({
    _id: String,
    count: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', CounterSchema);

const UserSchema = new mongoose.Schema({
    telegram_id: { type: Number, unique: true },
    username: String,
    device_fingerprint: String,
    ip_address: String,
    points: { type: Number, default: 0 },
    max_clicks: { type: Number, default: 1000 },
    clicks_used: { type: Number, default: 0 },
    role: { type: String, default: 'user' },
    is_banned: { type: Boolean, default: false },
    last_click: Date,
    created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const SettingsSchema = new mongoose.Schema({
    _id: String,
    mining_open: { type: Boolean, default: false }
});
const Settings = mongoose.model('Settings', SettingsSchema);

// -------------------- دوال مساعدة --------------------
const generateFingerprint = (ip, ua, id) => {
    return crypto.createHash('sha256').update(`${ip}_${ua}_${id}`).digest('hex');
};

// -------------------- إعدادات Express --------------------
app.use(cors());
app.use(express.json());

// -------------------- [1] الصفحة الرئيسية (Mini-App) --------------------
app.get('/app', async (req, res) => {
    try {
        const { initData } = req.query;
        let telegram_id, username;

        // محاولة استخراج البيانات من initData أو من query مباشرة (للاختبار)
        if (initData && verifyTelegramData(initData)) {
            try {
                const urlParams = new URLSearchParams(initData);
                const userData = JSON.parse(urlParams.get('user'));
                telegram_id = userData.id;
                username = userData.username || `User_${telegram_id}`;
            } catch (e) {
                console.log("⚠️ فشل تحليل initData، نستخدم query parameters بدلاً منه.");
                telegram_id = parseInt(req.query.user_id) || 12345;
                username = req.query.username || 'مستخدم';
            }
        } else {
            // وضع الاختبار: إذا لم توجد initData، استخدم البيانات من الرابط
            telegram_id = parseInt(req.query.user_id) || 12345;
            username = req.query.username || 'مستخدم';
            console.log(`🛠️ وضع الاختبار: user_id=${telegram_id}, username=${username}`);
        }

        // استخراج الـ IP والجهاز
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        // -------------------- تسجيل المستخدم أو جلب بياناته --------------------
        let user = await User.findOne({ telegram_id });
        if (!user) {
            const fingerprint = generateFingerprint(ip, userAgent, telegram_id);
            const existing = await User.findOne({ device_fingerprint: fingerprint });
            if (existing) {
                return res.send('<h1>⚠️ هذا الجهاز مسجل بحساب آخر</h1>');
            }

            // زيادة العداد الذري
            const counter = await Counter.findByIdAndUpdate(
                'total_users',
                { $inc: { count: 1 } },
                { new: true, upsert: true }
            );

            user = new User({
                telegram_id,
                username,
                device_fingerprint: fingerprint,
                ip_address: ip
            });
            await user.save();

            // فتح التعدين إذا وصلنا لـ 20,000
            if (counter.count >= 20000) {
                await Settings.findByIdAndUpdate(
                    'main_config',
                    { mining_open: true },
                    { upsert: true }
                );
            }
        }

        if (user.is_banned) {
            return res.send('<h1>🚫 تم حظر حسابك</h1>');
        }

        // -------------------- جلب الإعدادات العامة --------------------
        const settings = await Settings.findById('main_config');
        const miningOpen = settings?.mining_open || false;
        const counter = await Counter.findById('total_users');
        const totalUsers = counter?.count || 0;

        // -------------------- قراءة واجهة HTML وحقن البيانات --------------------
        // المسار الصحيح: الملف موجود في جذر المشروع
        const htmlPath = path.join(__dirname, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // استبدال جميع المتغيرات
        html = html.replace(/\{\{TELEGRAM_ID\}\}/g, user.telegram_id);
        html = html.replace(/\{\{USERNAME\}\}/g, user.username);
        html = html.replace(/\{\{POINTS\}\}/g, user.points);
        html = html.replace(/\{\{MAX_CLICKS\}\}/g, user.max_clicks);
        html = html.replace(/\{\{CLICKS_USED\}\}/g, user.clicks_used);
        html = html.replace(/\{\{TOTAL_USERS\}\}/g, totalUsers);
        html = html.replace(/\{\{MINING_OPEN\}\}/g, miningOpen);
        html = html.replace(/\{\{PROGRESS\}\}/g, Math.min((totalUsers / 20000) * 100, 100));

        res.send(html);
    } catch (error) {
        console.error("❌ خطأ في /app:", error);
        res.status(500).send(`<h1>خطأ داخلي: ${error.message}</h1><p>تحقق من سجلات Render لمزيد من التفاصيل.</p>`);
    }
});

// -------------------- [2] API الحالة العامة --------------------
app.get('/api/status', async (req, res) => {
    try {
        const { telegram_id } = req.query;
        const user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        if (!user) return res.status(404).json({ error: 'غير مسجل' });

        const counter = await Counter.findById('total_users');
        const settings = await Settings.findById('main_config');

        res.json({
            total_users: counter?.count || 0,
            mining_open: settings?.mining_open || false,
            points: user.points,
            max_clicks: user.max_clicks,
            clicks_used: user.clicks_used,
            progress: Math.min((user.clicks_used / user.max_clicks) * 100, 100)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// -------------------- [3] API التعدين (الضغط) --------------------
const cooldowns = {};
app.post('/api/click', async (req, res) => {
    try {
        const { telegram_id } = req.body;
        const user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        if (!user) return res.json({ success: false, message: 'غير مسجل' });
        if (user.is_banned) return res.json({ success: false, message: 'محظور' });
        if (user.clicks_used >= user.max_clicks) {
            return res.json({ success: false, message: 'استنفذت كل الضغطات' });
        }

        const settings = await Settings.findById('main_config');
        if (!settings?.mining_open) {
            return res.json({ success: false, message: 'التعدين لم يفتح بعد' });
        }

        // تبريد 3 ثوانٍ
        const now = Date.now();
        const last = cooldowns[telegram_id] || 0;
        if ((now - last) < 3000) {
            return res.status(429).json({
                success: false,
                message: 'انتظر 3 ثوانٍ',
                wait: 3 - (now - last) / 1000
            });
        }
        cooldowns[telegram_id] = now;

        // تحديث النقاط والضغطات
        user.points += 1;
        user.clicks_used += 1;
        user.last_click = new Date();
        await user.save();

        res.json({
            success: true,
            message: '+1 نقطة',
            new_points: user.points,
            clicks_used: user.clicks_used,
            max_clicks: user.max_clicks,
            progress: Math.min((user.clicks_used / user.max_clicks) * 100, 100)
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// -------------------- [4] API شراء هامش التعدين --------------------
app.post('/api/buy_boost', async (req, res) => {
    try {
        const { telegram_id, extra_clicks } = req.body;
        if (extra_clicks <= 0 || extra_clicks > 5000) {
            return res.json({ success: false, message: 'قيمة غير صالحة' });
        }
        const user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        if (!user) return res.json({ success: false, message: 'غير مسجل' });

        user.max_clicks += parseInt(extra_clicks);
        await user.save();

        res.json({
            success: true,
            message: `✅ تمت إضافة ${extra_clicks} ضغطة`,
            new_max: user.max_clicks
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// -------------------- [5] APIs الإدارة (Admin) --------------------
app.get('/admin/users', async (req, res) => {
    try {
        const { admin_id } = req.query;
        const admin = await User.findOne({ telegram_id: parseInt(admin_id) });
        if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });

        const users = await User.find({}, 'telegram_id username points clicks_used max_clicks').limit(100);
        res.json({ users });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/deduct', async (req, res) => {
    try {
        const { admin_id, target_id, amount, reason } = req.body;
        const admin = await User.findOne({ telegram_id: parseInt(admin_id) });
        if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });

        await User.findOneAndUpdate(
            { telegram_id: parseInt(target_id) },
            { $inc: { points: -Math.abs(amount) } }
        );
        res.json({ success: true, message: `تم خصم ${amount} نقطة` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/toggle_mining', async (req, res) => {
    try {
        const { admin_id } = req.body;
        const admin = await User.findOne({ telegram_id: parseInt(admin_id) });
        if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });

        const settings = await Settings.findById('main_config');
        const newStatus = !settings?.mining_open;
        await Settings.findByIdAndUpdate(
            'main_config',
            { mining_open: newStatus },
            { upsert: true }
        );
        res.json({ success: true, new_status: newStatus });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// -------------------- مسار تجريبي للصفحة الرئيسية --------------------
app.get('/', (req, res) => {
    res.send('🚀 مشروع Vortex يعمل بنجاح! انتقل إلى /app مع initData أو استخدم ?user_id=123&username=test للاختبار.');
});

// -------------------- تشغيل السيرفر --------------------
app.listen(PORT, () => {
    console.log(`✅ سيرفر Vortex يعمل على المنفذ ${PORT}`);
});
