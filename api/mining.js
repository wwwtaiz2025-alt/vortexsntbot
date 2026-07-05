const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST /api/start-mining
router.post('/start-mining', async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ error: 'telegram_id مطلوب' });
    }

    // 1. البحث عن المستخدم أو إنشاؤه
    let { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegram_id)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({ telegram_id, wallet_balance: 0, frozen_balance: 0 })
        .select()
        .single();

      if (insertError) throw insertError;
      user = newUser;
    }

    // 2. التحقق إذا كان التعدين نشطًا
    if (user.mining_started_at) {
      const now = new Date();
      const start = new Date(user.mining_started_at);
      const diffHours = (now - start) / (1000 * 60 * 60);
      if (diffHours < 24) {
        const remaining = Math.ceil(24 - diffHours);
        return res.json({
          success: true,
          message: `التعدين قيد التشغيل. متبقي ${remaining} ساعة تقريباً`,
          mining_active: true,
          remaining_hours: remaining
        });
      }
    }

    // 3. بدء التعدين
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('users')
      .update({ mining_started_at: now })
      .eq('id', user.id);

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: 'بدأ التعدين بنجاح. عد خلال 24 ساعة للحصاد.',
      mining_active: true,
      mining_started_at: now
    });

  } catch (err) {
    console.error('خطأ في start-mining:', err);
    return res.status(500).json({ error: 'حدث خطأ في الخادم' });
  }
});

module.exports = router;
