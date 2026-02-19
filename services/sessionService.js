const { Op } = require('sequelize');
const { Session, Setting, User } = require('../models');
const mikrotikService = require('./mikrotikService');

async function createSession(userId, mac, ip) {
  const durationHours = await Setting.getSessionDuration();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + durationHours);

  const session = await Session.create({
    user_id: userId,
    mac_address: mac || null,
    ip_address: ip || null,
    expires_at: expiresAt
  });

  console.log(`[Sessão] Criada para user ${userId}, expira em ${expiresAt.toLocaleString('pt-BR')}`);
  return session;
}

async function getActiveSession(userId) {
  return Session.findOne({
    where: {
      user_id: userId,
      active: true,
      expires_at: { [Op.gt]: new Date() }
    }
  });
}

async function expireSessions() {
  const expired = await Session.findAll({
    where: {
      active: true,
      expires_at: { [Op.lte]: new Date() }
    },
    include: [User]
  });

  if (expired.length === 0) return;

  console.log(`[Sessão] Expirando ${expired.length} sessão(ões)...`);

  for (const session of expired) {
    try {
      session.active = false;
      await session.save();

      if (session.User) {
        await mikrotikService.removeUser(session.User.cpf);
      }
    } catch (err) {
      console.error(`[Sessão] Erro ao expirar sessão ${session.id}:`, err.message);
    }
  }

  console.log(`[Sessão] ${expired.length} sessão(ões) expirada(s)`);
}

module.exports = { createSession, getActiveSession, expireSessions };
