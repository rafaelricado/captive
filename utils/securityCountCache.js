const { SecurityEvent, sequelize } = require('../models');
const { Op } = require('sequelize');

let _cache = { value: 0, expiresAt: 0 };

function invalidate() {
  _cache.expiresAt = 0;
}

async function getUnreadCount() {
  if (Date.now() < _cache.expiresAt) return _cache.value;
  const value = await SecurityEvent.count({
    where: {
      acknowledged: false,
      [Op.and]: [
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'attempt'`),
        sequelize.literal(`details->>'subtype' IS DISTINCT FROM 'register_attempt'`)
      ]
    }
  });
  _cache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

module.exports = { invalidate, getUnreadCount };
