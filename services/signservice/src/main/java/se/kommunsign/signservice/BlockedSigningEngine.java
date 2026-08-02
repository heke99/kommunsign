package se.kommunsign.signservice;

public final class BlockedSigningEngine implements SigningEngine {
    @Override public SignResult sign(SignCommand command) { return SignResult.notConfigured(); }
}
