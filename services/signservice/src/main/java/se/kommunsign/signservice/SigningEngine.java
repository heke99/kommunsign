package se.kommunsign.signservice;

public interface SigningEngine {
    /**
     * Signs the given PDF revision.
     *
     * @param command  what to sign and what it must remain bound to
     * @param assertion the already-verified identity evidence for this signer
     * @param documentBytes the exact PDF revision to sign
     */
    SignResult sign(SignCommand command, IdentityAssertion assertion, byte[] documentBytes);

    SigningEngineCapabilities capabilities();
}
