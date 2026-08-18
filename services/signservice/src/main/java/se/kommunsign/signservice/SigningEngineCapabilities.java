package se.kommunsign.signservice;

import java.util.Set;

/**
 * What a configured backend can actually do.
 *
 * {@code productionReady} is separate from "a backend is present" on purpose. A
 * software key and a self-signed test certificate produce a technically valid
 * signature, and a deployment that treated that as production-ready would be
 * issuing municipal decisions signed by nothing anyone can trace to an authority.
 */
public record SigningEngineCapabilities(
    String backend,
    String keyProtection,
    Set<String> supportedPadesLevels,
    boolean timestampConfigured,
    boolean productionReady) {

    public static final Set<String> KEY_PROTECTION_LEVELS = Set.of("SOFTWARE", "HSM", "REMOTE_QSCD");

    public SigningEngineCapabilities {
        if (backend == null || backend.isBlank()) throw new IllegalArgumentException("backend required");
        if (!KEY_PROTECTION_LEVELS.contains(keyProtection)) throw new IllegalArgumentException("unknown key protection level");
        supportedPadesLevels = supportedPadesLevels == null ? Set.of() : Set.copyOf(supportedPadesLevels);
    }

    public static SigningEngineCapabilities blocked() {
        return new SigningEngineCapabilities("NONE", "SOFTWARE", Set.of(), false, false);
    }
}
