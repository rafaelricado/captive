exports.showPortal = (req, res) => {
  const { mac, ip, username, 'link-orig': linkOrig } = req.query;

  res.render('portal', {
    mac: mac || '',
    ip: ip || '',
    username: username || '',
    linkOrig: linkOrig || '',
    error: null
  });
};

exports.showSuccess = (req, res) => {
  const { nome, linkOrig } = req.query;

  res.render('success', {
    nome: nome || 'Usuário',
    linkOrig: linkOrig || ''
  });
};
