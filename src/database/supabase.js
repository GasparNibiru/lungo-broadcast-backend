const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SECRET_KEY environment variables are required.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

module.exports = supabase;
