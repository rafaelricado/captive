const crypto = require('crypto');

function generateToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

// Injeta o token CSRF em res.locals para uso nos templates (GET requests)
function csrfMiddleware(req, res, next) {
  res.locals.csrfToken = generateToken(req);
  next();
}

// Verifica o token CSRF em requisições POST destrutivas.
// Aceita o token via campo _csrf no body (forms) ou header X-CSRF-Token (AJAX).
function verifyCsrf(req, res, next) {
  const sessionToken = req.session && req.session.csrfToken;
  const bodyToken = (req.body && req.body._csrf) || req.headers['x-csrf-token'];

  if (!sessionToken || !bodyToken || sessionToken !== bodyToken) {
    return res.status(403).send('Requisição inválida (token CSRF ausente ou incorreto).');
  }
  next();
}

module.exports = { csrfMiddleware, verifyCsrf };
