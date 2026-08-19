package se.kommunsign.signservice;

/**
 * The engine that refuses.
 *
 * This is the default, and it stays the default until key material, a key
 * protection level and a trusted certificate chain are all configured. A stub
 * that returned some plausible-looking artifact would produce cases that read as
 * signed and are not, which is worse than an outage: an outage is noticed.
 */
public final class BlockedSigningEngine implements SigningEngine {
    @Override public SignResult sign(SignCommand command, IdentityAssertion assertion, byte[] documentBytes) {
        return SignResult.notConfigured();
    }

    @Override public SigningEngineCapabilities capabilities() {
        return SigningEngineCapabilities.blocked();
    }
}
