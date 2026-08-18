package se.kommunsign.integration;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Security;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import se.swedenconnect.security.credential.BasicCredential;
import se.swedenconnect.security.credential.PkiCredential;

/**
 * A throwaway CA for tests.
 *
 * Generated in memory on every run and never written to disk, because a test
 * keystore committed to the repository is a production keystore waiting for
 * someone to point an environment variable at it. The repository verification
 * gate refuses committed key material for exactly this reason.
 */
final class SigningTestAuthority {

    static { Security.addProvider(new BouncyCastleProvider()); }

    private final KeyPair authorityKeyPair;
    private final X509Certificate authorityCertificate;

    SigningTestAuthority(String commonName) throws Exception {
        this.authorityKeyPair = generateKeyPair();
        X500Name name = new X500Name("CN=" + commonName + ",O=Kommunsign Test,C=SE");
        this.authorityCertificate = new JcaX509CertificateConverter().setProvider("BC").getCertificate(
            new JcaX509v3CertificateBuilder(name, BigInteger.ONE, notBefore(), notAfter(), name, authorityKeyPair.getPublic())
                .addExtension(Extension.basicConstraints, true, new BasicConstraints(0))
                .addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.keyCertSign | KeyUsage.cRLSign))
                .build(new JcaContentSignerBuilder("SHA256withRSA").setProvider("BC").build(authorityKeyPair.getPrivate())));
    }

    X509Certificate certificate() { return authorityCertificate; }

    String certificateBase64() throws Exception {
        return Base64.getEncoder().encodeToString(authorityCertificate.getEncoded());
    }

    /** Issues a signer credential whose subject carries a Swedish personal number, as a real AES signing certificate does. */
    PkiCredential issueSignerCredential(String commonName, String personalNumber) throws Exception {
        KeyPair keyPair = generateKeyPair();
        X500Name subject = new X500Name("CN=" + commonName + ",serialNumber=" + personalNumber + ",O=Kungalvs kommun,C=SE");
        X509Certificate certificate = new JcaX509CertificateConverter().setProvider("BC").getCertificate(
            new JcaX509v3CertificateBuilder(authorityCertificate, BigInteger.valueOf(System.nanoTime()), notBefore(), notAfter(), subject, keyPair.getPublic())
                .addExtension(Extension.basicConstraints, true, new BasicConstraints(false))
                .addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.nonRepudiation))
                .build(new JcaContentSignerBuilder("SHA256withRSA").setProvider("BC").build(authorityKeyPair.getPrivate())));
        return new BasicCredential(List.of(certificate, authorityCertificate), keyPair.getPrivate());
    }

    static byte[] singlePagePdf() throws Exception {
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            document.addPage(new PDPage());
            document.save(out);
            return out.toByteArray();
        }
    }

    private static KeyPair generateKeyPair() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        return generator.generateKeyPair();
    }

    private static Date notBefore() { return new Date(System.currentTimeMillis() - 86_400_000L); }
    private static Date notAfter() { return new Date(System.currentTimeMillis() + 86_400_000L * 365); }
}
