module.exports = function adminAuth(req, res, next) {
  if (req.session && req.session.adminLoggedIn) {
    return next();
  }
  res.redirect('/admin/login');
};
