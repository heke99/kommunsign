package se.kommunsign.signservice;

import java.util.Map;

/**
 * Selects the signing backend for this deployment.
 *
 * The default is {@link BlockedSigningEngine}. That is the point: a deployment
 * that has not been given CA-issued key material, an HSM or remote QSCD, and a
 * TSA must refuse to sign rather than produce an artifact that looks like a
 * signature and is not (AGENTS.md rule 10).
 *
 * Selection is by configured capability, never by a provider name compiled
 * into the core. Adding a DSS-backed backend is a factory registration, not a
 * change to the pipeline.
 */
public final class SigningEngineFactory {

    /** Set when a real backend is wired in; absent means "refuse to sign". */
    public static final String BACKEND_KEY = "KOMMUNSIGN_SIGNING_BACKEND";
    public static final String KEY_PROTECTION_KEY = "KOMMUNSIGN_SIGNING_KEY_PROTECTION";

    private SigningEngineFactory() {}

    public static SigningEngine fromEnvironment(Map<String, String> environment) {
        String backend = trimmedOrNull(environment.get(BACKEND_KEY));
        if (backend == null) return new BlockedSigningEngine();
        // A backend name alone is not enough. Without a declared key protection
        // level we cannot tell whether the signature would even reach the level
        // the policy asks for, so we block rather than guess.
        String keyProtection = trimmedOrNull(environment.get(KEY_PROTECTION_KEY));
        if (keyProtection == null || !isKnownKeyProtection(keyProtection)) return new BlockedSigningEngine();
        // No backend implementation is registered yet. When one is added it is
        // returned here; until then the refusal is the honest answer.
        return new BlockedSigningEngine();
    }

    static boolean isKnownKeyProtection(String value) {
        return value.equals("SOFTWARE") || value.equals("HSM") || value.equals("REMOTE_QSCD");
    }

    private static String trimmedOrNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
