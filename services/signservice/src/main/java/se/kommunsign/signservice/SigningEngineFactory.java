package se.kommunsign.signservice;

import java.util.Map;
import se.swedenconnect.security.credential.PkiCredential;

/**
 * Selects the signing backend for this deployment.
 *
 * The default is {@link BlockedSigningEngine}. That is the point: a deployment
 * that has not been given CA-issued key material, an HSM or remote QSCD, and a
 * TSA must refuse to sign rather than produce an artifact that looks like a
 * signature and is not (AGENTS.md rule 10).
 *
 * Selection is by configured capability, never by a provider name compiled into
 * the core. The Sweden Connect backend is registered here (ADR 0004); adding
 * another is a factory registration, not a change to the pipeline.
 *
 * Production is held to a stricter bar than test. In production a software key
 * is refused outright, because "advanced electronic signature" is a claim about
 * sole control of the signing key, and a PKCS#12 file on a container filesystem
 * does not support that claim however valid the resulting CMS structure is.
 */
public final class SigningEngineFactory {

    /** Set when a real backend is wired in; absent means "refuse to sign". */
    public static final String BACKEND_KEY = "KOMMUNSIGN_SIGNING_BACKEND";
    public static final String KEY_PROTECTION_KEY = "KOMMUNSIGN_SIGNING_KEY_PROTECTION";
    public static final String TIMESTAMP_URL_KEY = "KOMMUNSIGN_SIGNING_TSA_URL";
    public static final String APP_ENV_KEY = "APP_ENV";
    public static final String SWEDEN_CONNECT_BACKEND = "SWEDEN_CONNECT";

    private SigningEngineFactory() {}

    public static SigningEngine fromEnvironment(Map<String, String> environment) {
        String backend = trimmedOrNull(environment.get(BACKEND_KEY));
        if (backend == null) return new BlockedSigningEngine();

        // A backend name alone is not enough. Without a declared key protection
        // level we cannot tell whether the signature would even reach the level
        // the policy asks for, so we block rather than guess.
        String keyProtection = trimmedOrNull(environment.get(KEY_PROTECTION_KEY));
        if (keyProtection == null || !SigningEngineCapabilities.KEY_PROTECTION_LEVELS.contains(keyProtection)) {
            return new BlockedSigningEngine();
        }

        if (!SWEDEN_CONNECT_BACKEND.equals(backend)) return new BlockedSigningEngine();

        boolean production = "production".equals(trimmedOrNull(environment.get(APP_ENV_KEY)));
        if (production && "SOFTWARE".equals(keyProtection)) return new BlockedSigningEngine();

        PkiCredential credential;
        try {
            credential = SigningCredentialLoader.load(environment);
        } catch (RuntimeException exception) {
            return new BlockedSigningEngine();
        }
        if (credential == null) return new BlockedSigningEngine();

        boolean timestampConfigured = trimmedOrNull(environment.get(TIMESTAMP_URL_KEY)) != null;

        // Production readiness is never inferred from the fact that a key loaded.
        // It requires a protected key and a timestamp source, both of which the
        // deployment must supply before anything here calls itself ready.
        boolean productionReady = !"SOFTWARE".equals(keyProtection) && timestampConfigured;

        return new SwedenConnectSigningEngine(credential, keyProtection, timestampConfigured, productionReady);
    }

    static boolean isKnownKeyProtection(String value) {
        return value != null && SigningEngineCapabilities.KEY_PROTECTION_LEVELS.contains(value);
    }

    private static String trimmedOrNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
