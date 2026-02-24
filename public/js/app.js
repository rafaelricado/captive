document.addEventListener('DOMContentLoaded', () => {
  // === TABS ===
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // === MÁSCARAS ===

  // Máscara de CPF
  function maskCPF(input) {
    input.addEventListener('input', () => {
      let v = input.value.replace(/\D/g, '');
      if (v.length > 11) v = v.slice(0, 11);
      if (v.length > 9) {
        v = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
      } else if (v.length > 6) {
        v = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
      } else if (v.length > 3) {
        v = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
      }
      input.value = v;
    });
  }

  // Máscara de Telefone
  function maskPhone(input) {
    input.addEventListener('input', () => {
      let v = input.value.replace(/\D/g, '');
      if (v.length > 11) v = v.slice(0, 11);
      if (v.length > 6) {
        v = v.replace(/(\d{2})(\d{5})(\d{1,4})/, '($1) $2-$3');
      } else if (v.length > 2) {
        v = v.replace(/(\d{2})(\d{1,5})/, '($1) $2');
      } else if (v.length > 0) {
        v = v.replace(/(\d{1,2})/, '($1');
      }
      input.value = v;
    });
  }

  // Máscara de CEP
  function maskCEP(input) {
    input.addEventListener('input', () => {
      let v = input.value.replace(/\D/g, '');
      if (v.length > 8) v = v.slice(0, 8);
      if (v.length > 5) {
        v = v.replace(/(\d{5})(\d{1,3})/, '$1-$2');
      }
      input.value = v;
    });
  }

  // Máscara de Data DD/MM/AAAA
  function maskDate(input) {
    input.addEventListener('input', () => {
      let v = input.value.replace(/\D/g, '');
      if (v.length > 8) v = v.slice(0, 8);
      if (v.length > 4) v = v.replace(/(\d{2})(\d{2})(\d{0,4})/, '$1/$2/$3');
      else if (v.length > 2) v = v.replace(/(\d{2})(\d{0,2})/, '$1/$2');
      input.value = v;
    });
  }

  // Aplicar máscaras
  const cpfInput = document.getElementById('cpf');
  const cpfLoginInput = document.getElementById('cpf-login');
  const telefoneInput = document.getElementById('telefone');
  const cepInput = document.getElementById('cep');
  const dataNascInput = document.getElementById('data_nascimento');
  const dataNascLoginInput = document.getElementById('data_nascimento_login');

  if (cpfInput) maskCPF(cpfInput);
  if (cpfLoginInput) maskCPF(cpfLoginInput);
  if (telefoneInput) maskPhone(telefoneInput);
  if (cepInput) maskCEP(cepInput);
  if (dataNascInput) maskDate(dataNascInput);
  if (dataNascLoginInput) maskDate(dataNascLoginInput);

  // === VALIDAÇÃO E LÓGICA DE DATA DE NASCIMENTO ===

  // Parseia DD/MM/AAAA e retorna um Date ou null se inválida/futura
  function parseDateBR(str) {
    if (!str || str.length !== 10) return null;
    const parts = str.split('/');
    if (parts.length !== 3) return null;
    const [d, m, y] = parts.map(Number);
    if (!d || !m || !y || y < 1900 || y > 9999) return null;
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    if (date >= new Date()) return null; // não permite data futura ou hoje
    return date;
  }

  function calcIdade(date) {
    const hoje = new Date();
    let age = hoje.getFullYear() - date.getFullYear();
    const md = hoje.getMonth() - date.getMonth();
    if (md < 0 || (md === 0 && hoje.getDate() < date.getDate())) age--;
    return age;
  }

  // Lógica condicional: mostrar campo nome_mae apenas para menores de 18
  const nomeMaeGroup = document.getElementById('nome-mae-group');
  const nomeMaeInput = document.getElementById('nome_mae');
  const dataStatus = document.getElementById('data-status');

  if (dataNascInput && nomeMaeGroup) {
    dataNascInput.addEventListener('input', () => {
      const val = dataNascInput.value;

      if (val.length < 10) {
        if (dataStatus) { dataStatus.textContent = ''; dataStatus.className = 'field-status'; }
        nomeMaeGroup.style.display = 'none';
        if (nomeMaeInput) { nomeMaeInput.required = false; nomeMaeInput.value = ''; }
        return;
      }

      const date = parseDateBR(val);
      if (!date) {
        if (dataStatus) { dataStatus.textContent = 'Data invalida'; dataStatus.className = 'field-status invalid'; }
        nomeMaeGroup.style.display = 'none';
        if (nomeMaeInput) { nomeMaeInput.required = false; nomeMaeInput.value = ''; }
        return;
      }

      if (dataStatus) { dataStatus.textContent = ''; dataStatus.className = 'field-status'; }

      const idade = calcIdade(date);
      if (idade < 18) {
        nomeMaeGroup.style.display = '';
        if (nomeMaeInput) nomeMaeInput.required = true;
      } else {
        nomeMaeGroup.style.display = 'none';
        if (nomeMaeInput) { nomeMaeInput.required = false; nomeMaeInput.value = ''; }
      }
    });
  }

  // === VALIDAÇÃO DE CPF ===
  function validateCPF(cpf) {
    cpf = cpf.replace(/\D/g, '');
    if (cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false;

    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i)) * (10 - i);
    let rem = (sum * 10) % 11;
    if (rem === 10) rem = 0;
    if (rem !== parseInt(cpf.charAt(9))) return false;

    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(cpf.charAt(i)) * (11 - i);
    rem = (sum * 10) % 11;
    if (rem === 10) rem = 0;
    if (rem !== parseInt(cpf.charAt(10))) return false;

    return true;
  }

  // Validação em tempo real do CPF
  if (cpfInput) {
    const cpfStatus = document.getElementById('cpf-status');
    cpfInput.addEventListener('input', () => {
      const raw = cpfInput.value.replace(/\D/g, '');
      if (raw.length === 11) {
        if (validateCPF(raw)) {
          cpfStatus.textContent = 'CPF valido';
          cpfStatus.className = 'field-status valid';
          cpfInput.style.borderColor = '#059669';
        } else {
          cpfStatus.textContent = 'CPF invalido';
          cpfStatus.className = 'field-status invalid';
          cpfInput.style.borderColor = '#dc2626';
        }
      } else {
        cpfStatus.textContent = '';
        cpfStatus.className = 'field-status';
        cpfInput.style.borderColor = '';
      }
    });
  }

  // === CONSULTA CEP (ViaCEP) ===
  if (cepInput) {
    const cepStatus = document.getElementById('cep-status');
    let cepTimeout;

    cepInput.addEventListener('input', () => {
      clearTimeout(cepTimeout);
      const raw = cepInput.value.replace(/\D/g, '');

      if (raw.length === 8) {
        cepStatus.textContent = 'Buscando...';
        cepStatus.className = 'field-status loading';

        cepTimeout = setTimeout(() => {
          fetch('/api/cep/' + raw)
            .then(res => res.json())
            .then(data => {
              if (data.error) {
                cepStatus.textContent = 'CEP nao encontrado';
                cepStatus.className = 'field-status invalid';
                clearAddressFields();
              } else {
                cepStatus.textContent = 'CEP encontrado';
                cepStatus.className = 'field-status valid';
                fillAddressFields(data);
              }
            })
            .catch(() => {
              cepStatus.textContent = 'Erro ao buscar CEP';
              cepStatus.className = 'field-status invalid';
            });
        }, 300);
      } else {
        cepStatus.textContent = '';
        cepStatus.className = 'field-status';
        clearAddressFields();
      }
    });
  }

  function fillAddressFields(data) {
    const logradouro = document.getElementById('logradouro');
    const bairro = document.getElementById('bairro');
    const cidade = document.getElementById('cidade');
    const estado = document.getElementById('estado');

    if (logradouro) logradouro.value = data.logradouro || '';
    if (bairro) bairro.value = data.bairro || '';
    if (cidade) cidade.value = data.localidade || '';
    if (estado) estado.value = data.uf || '';

    // Foca no campo número após preencher endereço
    const numero = document.getElementById('numero');
    if (numero) numero.focus();
  }

  function clearAddressFields() {
    const fields = ['logradouro', 'bairro', 'cidade', 'estado'];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  // === VALIDAÇÃO DO FORMULÁRIO DE CADASTRO ===
  const formCadastro = document.getElementById('form-cadastro');
  if (formCadastro) {
    formCadastro.addEventListener('submit', (e) => {
      if (cpfInput) {
        const cpfRaw = cpfInput.value.replace(/\D/g, '');
        if (!validateCPF(cpfRaw)) {
          e.preventDefault();
          alert('CPF invalido. Verifique e tente novamente.');
          cpfInput.focus();
          return;
        }
      }

      if (dataNascInput) {
        const date = parseDateBR(dataNascInput.value);
        if (!date) {
          e.preventDefault();
          alert('Data de nascimento invalida. Use o formato DD/MM/AAAA.');
          dataNascInput.focus();
          return;
        }
        if (nomeMaeInput && nomeMaeInput.required && !nomeMaeInput.value.trim()) {
          e.preventDefault();
          alert('Para menores de 18 anos, o nome completo da mae e obrigatorio.');
          nomeMaeInput.focus();
          return;
        }
      }

      if (telefoneInput) {
        const telefoneRaw = telefoneInput.value.replace(/\D/g, '');
        if (telefoneRaw.length < 10) {
          e.preventDefault();
          alert('Telefone invalido. Digite o numero completo com DDD.');
          telefoneInput.focus();
          return;
        }
      }

      if (cepInput) {
        const cepRaw = cepInput.value.replace(/\D/g, '');
        if (cepRaw.length !== 8) {
          e.preventDefault();
          alert('CEP invalido. Digite o CEP completo.');
          cepInput.focus();
          return;
        }
      }
    });
  }

  // === VALIDAÇÃO DO FORMULÁRIO DE LOGIN ===
  const formLogin = document.getElementById('form-login');
  if (formLogin) {
    formLogin.addEventListener('submit', (e) => {
      if (dataNascLoginInput) {
        const date = parseDateBR(dataNascLoginInput.value);
        if (!date) {
          e.preventDefault();
          alert('Data de nascimento invalida. Use o formato DD/MM/AAAA.');
          dataNascLoginInput.focus();
          return;
        }
      }
    });
  }
});
