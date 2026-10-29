'use strict';
// Read-only share links for the nutrition plan (to send by e-mail, WhatsApp or Telegram).
// Privacy rules:
//  - created only after an explicit confirmation; expire after 1, 7 or 30 days; revocable at any time;
//  - the link holds a snapshot of the plan in "share mode" (no e-mail, no screening reasons, no energy
//    availability, no personal sweat rate); the token is random and only its hash is stored;
//  - stops working when the owner's subscription is not active, or when the account is deleted.
const MAX_ACTIVE = 20;
const DAYS = [1, 7, 30];

function messageText(url, days) {
  return `خطة التغذية بتاعتي على أكلني | Eklni (رابط للقراءة بس، صالح ${days === 1 ? 'يوم' : `${days} أيام`}): ${url}`;
}
function shareTargets(url, days) {
  const text = messageText(url, days);
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('خطة التغذية — أكلني | Eklni')}`,
    email: `mailto:?subject=${encodeURIComponent('خطة التغذية — أكلني | Eklni')}&body=${encodeURIComponent(text)}`,
    text,
  };
}

// deps: { randomToken(), hash(t), nowMs(), render(share options) → html | {error} , baseUrl }
function create(db, userId, body, deps) {
  if (body.confirm !== true) return { error: 'CONFIRM_REQUIRED', status: 400, message: 'أكّد إنك عارف إن أي حد معاه الرابط هيقدر يشوف الخطة.' };
  const days = Number(body.days);
  if (!DAYS.includes(days)) return { error: 'VALIDATION', status: 400, message: 'مدة الرابط: يوم أو 7 أيام أو 30 يوم.' };
  if (db.activeShareCount(userId, deps.nowMs()) >= MAX_ACTIVE) return { error: 'TOO_MANY', status: 400, message: `عندك ${MAX_ACTIVE} رابط شغالين؛ الغي القديم الأول.` };
  const r = deps.render({ showName: body.showName === true });
  if (r.error) return { error: r.error, status: 400, message: r.message || 'اعمل خطة الأسبوع الأول.' };
  const token = deps.randomToken();
  const expiresAt = deps.nowMs() + days * 86400000;
  const id = db.addShare(deps.hash(token), userId, r.html, expiresAt);
  const url = `${deps.baseUrl}/s/${token}`;
  return { id, url, expiresAt: new Date(expiresAt).toISOString(), days, ...shareTargets(url, days) };
}

module.exports = { create, shareTargets, MAX_ACTIVE, DAYS };
