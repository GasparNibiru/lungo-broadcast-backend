// Start wrapper for EasyPanel deployment.
// This forces permissive CORS during frontend/backend integration tests.
process.env.ALLOWED_ORIGINS = '*';
require('./server');
