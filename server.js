const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// --- إعدادات الـ MongoDB ---
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ متصل بقاعدة البيانات'))
  .catch(err => console.log('❌ خطأ في الاتصال:', err));

// --- نماذج قاعدة البيانات (Schemas) ---
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
  role: { type: String, default: 'user' }, // user, admin, support
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

// --- دوال المساعدة (بنفس منطق Python السابق) ---
const generateFingerprint = (ip, ua, id) => {
  return crypto.createHash('sha256').update(`${ip}_${ua}_${id}`).digest('hex');
};

// تشغيل التطبيق
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // لخدمة ملف index.html

// --- 1. API التسجيل والتطبيق الرئيسي ---
app.get('/app', async (req, res) => {
  try {
    const { initData } = req.query;
    // تبسيطاً: نستقبل البيانات مباشرة (بدون التحقق المعقد حالياً لتسهيل التجربة)
    const telegram_id = parseInt(req.query.user_id) || 12345; // مؤقت
    const username = req.query.username || 'مستخدم';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

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

    if (user.is_banned) return res.send('<h1>تم حظر حسابك</h1>');

    // جلب الإعدادات
    let settings = await Settings.findById('main_config');
    const miningOpen = settings?.mining_open || false;
    const counter = await Counter.findById('total_users');
    const totalUsers = counter?.count || 0;

    // قراءة ملف الواجهة وإدخال البيانات
    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    
    // استبدال المتغيرات
    html = html.replace(/\{\{TELEGRAM_ID\}\}/g, user.telegram_id);
    html = html.replace(/\{\{USERNAME\}\}/g, user.username);
    html = html.replace(/\{\{POINTS\}\}/g, user.points);
    html = html.replace(/\{\{MAX_CLICKS\}\}/g, user.max_clicks);
    html = html.replace(/\{\{CLICKS_USED\}\}/g, user.clicks_used);
    html = html.replace(/\{\{TOTAL_USERS\}\}/g, totalUsers);
    html = html.replace(/\{\{MINING_OPEN\}\}/g, miningOpen);
    html = html.replace(/\{\{PROGRESS\}\}/g, Math.min((totalUsers / 20000) * 100, 100));

    res.send(html);
  } catch (e) {
    res.status(500).send(`خطأ: ${e.message}`);
  }
});

// --- 2. API حالة النظام ---
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

// --- 3. API التعدين (الضغط) مع تبريد 3 ثوان ---
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

    // حماية التبريد
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

    // تحديث البيانات
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

// --- 4. API شراء هامش التعدين ---
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
      message: `تمت إضافة ${extra_clicks} ضغطة`,
      new_max: user.max_clicks
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- 5. APIs الإدارة (Admin) ---
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

// --- بدء السيرفر ---
app.listen(PORT, () => {
  console.log(`🚀 سيرفر Vortex يعمل على http://localhost:${PORT}`);
});
