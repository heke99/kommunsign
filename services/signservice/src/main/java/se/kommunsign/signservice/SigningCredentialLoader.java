package se.kommunsign.signservice;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import se.swedenconnect.security.credential.BasicCredential;
import se.swedenconnect.security.credential.PkiCredential;

/**
 * Loads the signing credential named by the environment.
 *
 * Two protection levels are loadable here: SOFTWARE, from a PKCS#12 keystore on
 * disk, and HSM/REMOTE_QSCD, from a PKCS#11 token. Nothing is generated on the
 * fly. A service that could mint its own key when it failed to find one would
 * turn a misconfiguration into a silently untrusted signature.
 *
 * The keystore path and password arrive as environment values and are never
 * logged, not even at debug, and never echoed in an error message.
 */
public final class SigningCredentialLoader {

    public static final String KEYSTORE_PATH = "KOMMUNSIGN_SIGNING_KEYSTORE_PATH";
    public static final String KEYSTORE_PASSWORD = "KOMMUNSIGN_SIGNING_KEYSTORE_PASSWORD";
    public static final String KEY_ALIAS = "KOMMUNSIGN_SIGNING_KEY_ALIAS";
    public static final String KEY_PASSWORD = "KOMMUNSIGN_SIGNING_KEY_PASSWORD";
    public static final String PKCS11_CONFIG = "KOMMUNSIGN_SIGNING_PKCS11_CONFIG";

    private SigningCredentialLoader() {}

    /** Returns the configured credential, or null when the deployment has none. */
    public static PkiCredential load(Map<String, String> environment) {
        String keystorePath = trimmedOrNull(environment.get(KEYSTORE_PATH));
        String pkcs11Config = trimmedOrNull(environment.get(PKCS11_CONFIG));
        if (keystorePath == null && pkcs11Config == null) return null;

        String alias = trimmedOrNull(environment.get(KEY_ALIAS));
        if (alias == null) return null;
        char[] storePassword = charsOrNull(environment.get(KEYSTORE_PASSWORD));
        char[] keyPassword = charsOrNull(environment.get(KEY_PASSWORD));
        if (keyPassword == null) keyPassword = storePassword;

        try {
            KeyStore keyStore;
            if (pkcs11Config != null) {
                // The token holds the key; only the certificate ever leaves it.
                keyStore = KeyStore.getInstance("PKCS11");
                keyStore.load(null, storePassword);
            } else {
                Path path = Path.of(keystorePath);
                if (!Files.isReadable(path)) return null;
                keyStore = KeyStore.getInstance("PKCS12");
                try (InputStream stream = Files.newInputStream(path)) {
                    keyStore.load(stream, storePassword);
                }
            }

            PrivateKey privateKey = (PrivateKey) keyStore.getKey(alias, keyPassword);
            Certificate[] chain = keyStore.getCertificateChain(alias);
            if (privateKey == null || chain == null || chain.length == 0) return null;

            List<X509Certificate> certificates = new ArrayList<>(chain.length);
            for (Certificate certificate : chain) {
                if (certificate instanceof X509Certificate x509) certificates.add(x509);
            }
            if (certificates.isEmpty()) return null;
            return new BasicCredential(certificates, privateKey);
        } catch (Exception exception) {
            // Deliberately no detail: the message could carry the keystore path.
            throw new IllegalStateException("signing credential could not be loaded");
        } finally {
            if (storePassword != null) java.util.Arrays.fill(storePassword, '\0');
            if (keyPassword != null) java.util.Arrays.fill(keyPassword, '\0');
        }
    }

    private static String trimmedOrNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static char[] charsOrNull(String value) {
        String trimmed = trimmedOrNull(value);
        return trimmed == null ? null : trimmed.toCharArray();
    }
}
