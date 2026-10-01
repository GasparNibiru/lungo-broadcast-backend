'use strict';
const crypto = require('crypto');

function view(data, organizationId) {
  const vacancy = data.vacancies.find(v => v.organizationId === organizationId) || null;
  const candidates = data.candidates.filter(c => c.organizationId === organizationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ disc, profilePhotoUrl, profile_photo_url, photo, ...candidate }) => ({
      ...candidate,
      disc: disc ? { sentAt: disc.sentAt || null, completedAt: disc.completedAt || null,
        emailSent: Boolean(disc.emailSent), result: disc.result || null } : null
    }));
  const version = crypto.createHash('sha256').update(JSON.stringify({ vacancy, candidates })).digest('hex');
  return { vacancy, candidates, version };
}

function updates(data, organizationId) {
  const { version, candidates } = view(data, organizationId);
  const unread = candidates.find(c => !c.seenAt);
  return { version, notification: unread ? {
    id: unread.id, name: unread.name, city: unread.city, experience: unread.experience,
    disc: unread.disc?.completedAt ? { completedAt: unread.disc.completedAt } : null
  } : null };
}

module.exports = { view, updates };
