package se.kommunsign.signservice;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The factory's job is to refuse. Each case here is a configuration that looks
 * close enough to working that someone could ship it believing signing was on.
 */
class SigningEngineFactoryTest {

    private static Map<String, String> environment(String... pairs) {
        Map<String, String> environment = new HashMap<>();
        for (int index = 0; index < pairs.length; index += 2) environment.put(pairs[index], pairs[index + 1]);
        return environment;
    }

    @Test
    void an_unconfigured_deployment_refuses_to_sign() {
        assertInstanceOf(BlockedSigningEngine.class, SigningEngineFactory.fromEnvironment(Map.of()));
    }

    @Test
    void a_backend_without_a_declared_key_protection_level_refuses_to_sign() {
        assertInstanceOf(BlockedSigningEngine.class, SigningEngineFactory.fromEnvironment(
            environment("KOMMUNSIGN_SIGNING_BACKEND", "SWEDEN_CONNECT")));
    }

    @Test
    void an_unrecognised_key_protection_level_refuses_to_sign() {
        assertInstanceOf(BlockedSigningEngine.class, SigningEngineFactory.fromEnvironment(
            environment("KOMMUNSIGN_SIGNING_BACKEND", "SWEDEN_CONNECT",
                        "KOMMUNSIGN_SIGNING_KEY_PROTECTION", "PROBABLY_FINE")));
    }

    @Test
    void an_unknown_backend_name_refuses_rather_than_falling_back() {
        assertInstanceOf(BlockedSigningEngine.class, SigningEngineFactory.fromEnvironment(
            environment("KOMMUNSIGN_SIGNING_BACKEND", "SOME_OTHER_VENDOR",
                        "KOMMUNSIGN_SIGNING_KEY_PROTECTION", "HSM")));
    }

    @Test
    void production_refuses_a_software_held_key_even_when_everything_else_is_configured() {
        assertInstanceOf(BlockedSigningEngine.class, SigningEngineFactory.fromEnvironment(
            environment("KOMMUNSIGN_SIGNING_BACKEND", "SWEDEN_CONNECT",
                        "KOMMUNSIGN_SIGNING_KEY_PROTECTION", "SOFTWARE",
                        "KOMMUNSIGN_SIGNING_KEYSTORE_PATH", "/nonexistent/keystore.p12",
                        "KOMMUNSIGN_SIGNING_KEY_ALIAS", "signing",
                        "APP_ENV", "production")));
    }

    @Test
    void a_declared_backend_with_no_loadable_key_material_refuses_to_sign() {
        assertInstanceOf(BlockedSigningEngine.class, SigningEngineFactory.fromEnvironment(
            environment("KOMMUNSIGN_SIGNING_BACKEND", "SWEDEN_CONNECT",
                        "KOMMUNSIGN_SIGNING_KEY_PROTECTION", "HSM",
                        "APP_ENV", "test")));
    }

    @Test
    void the_blocked_engine_reports_no_capability_rather_than_a_plausible_one() {
        SigningEngineCapabilities capabilities = new BlockedSigningEngine().capabilities();
        org.junit.jupiter.api.Assertions.assertEquals("NONE", capabilities.backend());
        org.junit.jupiter.api.Assertions.assertTrue(capabilities.supportedPadesLevels().isEmpty());
        org.junit.jupiter.api.Assertions.assertFalse(capabilities.productionReady());
    }
}
