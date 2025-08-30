// utils/negotiation.js
function getLastClientOffer(discussion = [], fallbackPrice = null) {
  // discussion = ["client:5000", "chauffeur:6000:last_offer", "client:5500", ...]
  // On prend le dernier message qui commence par "client:" et on extrait le montant.
  for (let i = discussion.length - 1; i >= 0; i--) {
    const msg = (discussion[i] || '').toString();
    if (msg.startsWith('client:')) {
      // formats possibles "client:5500", "client:5500:last_offer", "client:5500:accepted"
      const parts = msg.split(':');
      const maybe = parseInt(parts[1], 10);
      if (!Number.isNaN(maybe) && maybe > 0) return maybe;
    }
  }
  // sinon on retombe sur proposed_price s’il est fourni
  if (fallbackPrice && Number.isFinite(fallbackPrice)) return fallbackPrice;
  // sinon une valeur par défaut minimum
  return 3000;
}

module.exports = { getLastClientOffer };
