const express = require('express');
const supabase = require('../database/supabase');

const router = express.Router();

router.get('/health/database', async (req, res) => {
  try {
    const { error } = await supabase
      .from('plans')
      .select('id')
      .limit(1);

    if (error) throw error;

    res.status(200).json({
      ok: true,
      database: 'connected'
    });
  } catch (error) {
    console.error('[DATABASE HEALTH ERROR]', {
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint
    });

    res.status(500).json({
      ok: false,
      database: 'error'
    });
  }
});

module.exports = router;
