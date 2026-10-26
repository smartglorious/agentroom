const db = require("./db");
// A tenant owns campaigns; a campaign has instances (one game at one place) and participants identified by a QR code.
function addCampaign(tenantId, slug) { return db.insert("campaigns", { tenantId, slug }); }
function addInstance({ key, campaignSlug, type, config }) { return db.insert("instances", { key, campaignSlug, type, config }); }
function addParticipant({ id, campaignSlug, qrCode }) { return db.insert("participants", { id, campaignSlug, qrCode }); }
function instanceOf(key) { return db.find("instances", (i) => i.key === key); }
function participantByQr(qr) { return db.find("participants", (p) => p.qrCode === qr); }
function campaignOf(slug) { return db.find("campaigns", (c) => c.slug === slug); }
module.exports = { addCampaign, addInstance, addParticipant, instanceOf, participantByQr, campaignOf };
