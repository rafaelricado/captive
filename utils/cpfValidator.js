function validateCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');

  if (cpf.length !== 11) return false;

  // Rejeita CPFs com todos os dígitos iguais
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  // Validação do primeiro dígito verificador
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cpf.charAt(i)) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== parseInt(cpf.charAt(9))) return false;

  // Validação do segundo dígito verificador
  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(cpf.charAt(i)) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== parseInt(cpf.charAt(10))) return false;

  return true;
}

module.exports = { validateCPF };
