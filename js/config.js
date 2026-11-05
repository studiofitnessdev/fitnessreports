// Supabase project settings — Project Settings → API (or "API Keys").
// Use the "publishable" key (called "anon" on older projects).
// NEVER put the "secret" / "service_role" key here: this file is public.
window.APP_CONFIG = {
  supabaseUrl: 'https://riypfhmzbjvmqfaczysp.supabase.co',
  supabaseKey: 'sb_publishable_dJkUCMnLQoMkRBeeaGi9dA_KDofnq6T',

  // The two predefined logins. Emails must match the users created in Supabase.
  users: {
    owner:   { label: 'Anderson',  email: 'anderson@studiofitness.app' },
    teacher: { label: 'Professor', email: 'professores@studiofitness.app' },
  },
};
