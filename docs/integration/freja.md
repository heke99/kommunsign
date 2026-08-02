# Freja eID

KommunSign ska vara Integrator RP och varje kund Integrated RP. Den officiella Java-klienten körs i identity-service med mTLS. Privata nycklar hämtas från HSM/managed vault och finns aldrig i image eller Git.

För personbundna känsliga dokument används SSN, UPI eller EMAIL, inte INFERRED. Standard för formell svensk identitet är minst PLUS om inte dokumenterad policy beslutar annat.

JWS-verifiering måste kontrollera algorithm allowlist, certifikatkedja, aktuell/roterande verifieringsnyckel, transaction reference, signerare, tenant, policy, nonce, hash och expiry. Okända additiva fält ignoreras kompatibelt men råsvaret bevaras krypterat.
