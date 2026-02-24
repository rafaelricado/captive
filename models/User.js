const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  nome_completo: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [3, 255]
    }
  },
  cpf: {
    type: DataTypes.STRING(11),
    allowNull: false,
    unique: true,
    validate: {
      is: /^\d{11}$/
    }
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isEmail: true
    }
  },
  telefone: {
    type: DataTypes.STRING(15),
    allowNull: false,
    validate: {
      len: [10, 15]
    }
  },
  cep: {
    type: DataTypes.STRING(9),
    allowNull: false,
    validate: {
      is: /^\d{8}$/
    }
  },
  logradouro: {
    type: DataTypes.STRING
  },
  bairro: {
    type: DataTypes.STRING
  },
  cidade: {
    type: DataTypes.STRING
  },
  estado: {
    type: DataTypes.STRING(2),
    validate: {
      len: [2, 2]
    }
  },
  numero: {
    type: DataTypes.STRING,
    allowNull: false
  },
  complemento: {
    type: DataTypes.STRING
  },
  data_nascimento: {
    type: DataTypes.DATEONLY,
    allowNull: true  // null permitido para usuários migrados; controller impõe obrigatoriedade
  },
  nome_mae: {
    type: DataTypes.STRING,
    allowNull: true  // obrigatório apenas para menores de 18 anos (validado no controller)
  },
  lgpd_accepted_at: {
    type: DataTypes.DATE,
    allowNull: true  // null = usuários anteriores à implementação da LGPD
  }
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = User;
