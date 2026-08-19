package se.kommunsign.signservice;

import java.security.Security;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import se.idsec.signservice.security.sign.AdesProfileType;
import se.idsec.signservice.security.sign.pdf.PDFSignerParameters;
import se.idsec.signservice.security.sign.pdf.PDFSignerResult;
import se.idsec.signservice.security.sign.pdf.impl.DefaultPDFSigner;
import se.swedenconnect.security.credential.PkiCredential;

/**
 * PAdES signing on the Sweden Connect stack.
 *
 * The signature is produced by {@link DefaultPDFSigner}, which appends an
 * incremental PDF revision rather than rewriting the file. That is what makes
 * sequential signing safe: every earlier signature remains byte-for-byte intact
 * inside the new revision, so signer two cannot invalidate signer one, and a
 * validator can still recover exactly what each person signed.
 *
 * The engine reports the profile it produced and nothing more. It does not claim
 * a PAdES level. Level is a function of the evidence actually collected —
 * timestamps, revocation data, trust anchors — and that evidence is assembled and
 * judged downstream. An engine that announced "PAdES-LT" because it was asked for
 * PAdES-LT would defeat the admission gate rather than feed it.
 */
public final class SwedenConnectSigningEngine implements SigningEngine {

    /**
     * BouncyCastle has to be registered before any signature is attempted.
     *
     * DefaultPDFSigner reaches for the "BC" provider by name when it builds the
     * PAdES signed-certificate attribute, and throws if it is absent. Registering
     * it here, in the class that needs it, rather than leaving it to whoever
     * happens to construct the engine, is what makes this true in production and
     * not only where some other class already did it.
     *
     * This was a live defect. The Java tests registered BC in their own fixture,
     * so signing worked under test and failed in production: the service would
     * start, report signingAvailable: true, and refuse every signature with an
     * opaque SIGNING_FAILED. It was found by running the real chain over HTTP
     * against the built service, which is the only place the difference between
     * "the fixture set it up" and "the code sets it up" is visible.
     */
    static {
        ensureSecurityProvider();
    }

    /**
     * Checked again at every signature, not only at class load.
     *
     * A static block runs once. In a process that lives for weeks, anything that
     * re-initialises the security providers leaves the engine permanently unable
     * to sign, with no way back short of a restart. Re-checking costs a map
     * lookup and removes that failure mode entirely.
     */
    static void ensureSecurityProvider() {
        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
            Security.addProvider(new BouncyCastleProvider());
        }
    }

    private static final String RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    private static final String ECDSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";

    private final PkiCredential credential;
    private final String keyProtection;
    private final boolean timestampConfigured;
    private final boolean productionReady;

    public SwedenConnectSigningEngine(PkiCredential credential, String keyProtection, boolean timestampConfigured, boolean productionReady) {
        if (credential == null) throw new IllegalArgumentException("signing credential required");
        if (!SigningEngineCapabilities.KEY_PROTECTION_LEVELS.contains(keyProtection)) {
            throw new IllegalArgumentException("unknown key protection level");
        }
        this.credential = credential;
        this.keyProtection = keyProtection;
        this.timestampConfigured = timestampConfigured;
        this.productionReady = productionReady;
    }

    @Override
    public SigningEngineCapabilities capabilities() {
        // Only B and T are offered. LT and LTA need revocation material and an
        // archive timestamp that this engine does not itself collect, and
        // advertising them here would let a policy requiring LTA pass a check it
        // has not actually met.
        Set<String> levels = timestampConfigured ? Set.of("PAdES-B", "PAdES-T") : Set.of("PAdES-B");
        return new SigningEngineCapabilities("SWEDEN_CONNECT", keyProtection, levels, timestampConfigured, productionReady);
    }

    @Override
    public SignResult sign(SignCommand command, IdentityAssertion assertion, byte[] documentBytes) {
        try {
            TicIdentityBinding.assertBound(command, assertion, documentBytes);
        } catch (TicIdentityBinding.BindingViolation violation) {
            return SignResult.refused(violation.safeCode());
        }

        if (!capabilities().supportedPadesLevels().contains(command.requestedPadesLevel())) {
            return SignResult.refused("REQUESTED_PADES_LEVEL_NOT_SUPPORTED_BY_BACKEND");
        }

        try {
            ensureSecurityProvider();
            PDFSignerParameters parameters = new PDFSignerParameters();
            parameters.setPadesType(AdesProfileType.BES);

            DefaultPDFSigner signer = new DefaultPDFSigner(credential, algorithmUriFor(credential));
            signer.setIncludeCertificateChain(true);
            PDFSignerResult result = signer.sign(documentBytes, parameters);

            byte[] signedDocument = result.getSignedDocument();
            if (signedDocument == null || signedDocument.length <= documentBytes.length) {
                return SignResult.refused("SIGNED_REVISION_NOT_PRODUCED");
            }
            // The whole multi-signer guarantee rests on this being an append.
            if (!isPrefix(documentBytes, signedDocument)) {
                return SignResult.refused("SIGNED_REVISION_NOT_INCREMENTAL");
            }

            X509Certificate signingCertificate = credential.getCertificate();
            List<byte[]> chain = new ArrayList<>();
            for (X509Certificate certificate : credential.getCertificateChain()) {
                chain.add(certificate.getEncoded());
            }

            return SignResult.signed(
                signedDocument,
                TicIdentityBinding.sha256Hex(signedDocument),
                signingCertificate.getEncoded(),
                chain,
                algorithmUriFor(credential),
                AdesProfileType.BES.name(),
                Instant.now().toString());
        } catch (Exception exception) {
            // No detail reaches the caller: an exception here can carry key
            // paths or document bytes. But refusing to record it anywhere left
            // an operator with nothing to diagnose — a missing security provider
            // and a corrupt PDF produced the identical opaque answer, and the
            // provider case went unnoticed until the chain was run for real.
            //
            // The class name and the safe codes below are enough to tell the
            // failure modes apart and carry no material.
            logSafely(exception);
            return SignResult.refused("SIGNING_FAILED");
        }
    }

    /**
     * Records what kind of failure occurred, never what was in it.
     *
     * Only the exception class name and a small set of recognised conditions are
     * written. The message is deliberately excluded: it is the part that carries
     * file paths, key aliases and occasionally document content.
     */
    private static void logSafely(Exception exception) {
        String classification = "UNCLASSIFIED";
        for (Throwable current = exception; current != null; current = current.getCause()) {
            if (current instanceof java.security.NoSuchProviderException
                || current instanceof SecurityException) {
                classification = "SECURITY_PROVIDER_MISSING";
                break;
            }
            if (current instanceof java.io.IOException) {
                classification = "DOCUMENT_NOT_READABLE";
                break;
            }
            if (current instanceof java.security.GeneralSecurityException) {
                classification = "KEY_OR_ALGORITHM_REJECTED";
                break;
            }
        }
        System.err.println("{\"level\":\"error\",\"service\":\"kommunsign-signservice\""
            + ",\"event\":\"signing_failed\",\"classification\":\"" + classification
            + "\",\"exception\":\"" + exception.getClass().getSimpleName() + "\"}");
    }

    private static boolean isPrefix(byte[] prefix, byte[] whole) {
        if (whole.length < prefix.length) return false;
        for (int index = 0; index < prefix.length; index += 1) {
            if (prefix[index] != whole[index]) return false;
        }
        return true;
    }

    private static String algorithmUriFor(PkiCredential credential) {
        String algorithm = credential.getPrivateKey().getAlgorithm();
        return "EC".equalsIgnoreCase(algorithm) ? ECDSA_SHA256 : RSA_SHA256;
    }
}
