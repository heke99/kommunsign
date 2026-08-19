package se.kommunsign.integration;

import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.security.*;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.crypto.dsig.*;
import javax.xml.crypto.dsig.dom.DOMSignContext;
import javax.xml.crypto.dsig.keyinfo.*;
import javax.xml.crypto.dsig.spec.*;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.*;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import java.io.ByteArrayOutputStream;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;
import org.w3c.dom.*;
import se.kommunsign.validation.SamlAssertionRequest;
import se.kommunsign.validation.SamlAssertionValidator;

/**
 * Proves the SAML validator against real signed XML rather than fixtures.
 *
 * Every case here is a complete authentication bypass if it goes the other way,
 * and each is easy to write by accident. Fixtures would not catch them: the
 * point is that the signature is real, and that changing one thing about it
 * changes the answer.
 */
final class SamlAssertionValidatorTest {

    static { Security.addProvider(new BouncyCastleProvider()); }

    private static final String AUDIENCE = "https://kungalv.kommunsign.se/sp";
    private static final String DESTINATION = "https://kungalv.kommunsign.se/auth/federation/GENERIC_SAML/acs";

    @Test
    void aResponseSignedByTheConfiguredIdpIsAcceptedAndNormalised() throws Exception {
        Idp idp = new Idp("idp.kungalv.se");
        String xml = idp.signedResponse("_assertion-1", "request-1", "anna.andersson",
            List.of("CN=Kommunsign-Handlaggare"), AUDIENCE, DESTINATION);

        Map<String,Object> result = new SamlAssertionValidator().validate(new SamlAssertionRequest(
            base64(xml), idp.certificateBase64(), AUDIENCE, DESTINATION));

        assertEquals("PASS", result.get("result"), () -> "reason: " + result.get("reason"));
        assertEquals(Boolean.TRUE, result.get("signatureVerified"));
        assertEquals("https://idp.kungalv.se/saml", result.get("issuer"));
        assertEquals(AUDIENCE, result.get("audience"));
        assertEquals(DESTINATION, result.get("destination"));
        assertEquals("request-1", result.get("inResponseTo"));
        assertEquals("_assertion-1", result.get("assertionId"));
        assertEquals("anna.andersson", result.get("subject"));

        @SuppressWarnings("unchecked")
        Map<String,List<String>> attributes = (Map<String,List<String>>) result.get("attributes");
        assertEquals(List.of("CN=Kommunsign-Handlaggare"), attributes.get("memberOf"));
        assertEquals(List.of("anna.andersson"), attributes.get("uid"));
    }

    @Test
    void aResponseSignedByAnotherIdpIsRefused() throws Exception {
        Idp real = new Idp("idp.kungalv.se");
        Idp impostor = new Idp("idp.kungalv.se");

        // Same issuer string, same everything a reader would look at — a
        // different key. Trusting the certificate inside the message would let
        // anybody with a text editor authenticate as anybody.
        String xml = impostor.signedResponse("_assertion-2", "request-1", "anna.andersson",
            List.of("CN=Kommunsign-Handlaggare"), AUDIENCE, DESTINATION);

        Map<String,Object> result = new SamlAssertionValidator().validate(new SamlAssertionRequest(
            base64(xml), real.certificateBase64(), AUDIENCE, DESTINATION));

        assertEquals("FAIL", result.get("result"));
        assertEquals("SIGNER_NOT_TRUSTED", result.get("reason"));
        assertEquals(Boolean.FALSE, result.get("signatureVerified"));
    }

    @Test
    void anAlteredAssertionIsRefused() throws Exception {
        Idp idp = new Idp("idp.kungalv.se");
        String xml = idp.signedResponse("_assertion-3", "request-1", "anna.andersson",
            List.of("CN=Kommunsign-Lasare"), AUDIENCE, DESTINATION);

        // Promote the user to a group that maps to a stronger role. The bytes
        // are otherwise identical and the signature is genuine.
        String tampered = xml.replace("CN=Kommunsign-Lasare", "CN=Kommunsign-Admin1");
        assertNotEquals(xml, tampered, "the test must actually change something");

        Map<String,Object> result = new SamlAssertionValidator().validate(new SamlAssertionRequest(
            base64(tampered), idp.certificateBase64(), AUDIENCE, DESTINATION));

        assertEquals("FAIL", result.get("result"));
        assertEquals("SIGNATURE_INVALID", result.get("reason"));
    }

    @Test
    void anUnsignedResponseIsRefused() throws Exception {
        Idp idp = new Idp("idp.kungalv.se");
        String xml = idp.unsignedResponse("_assertion-4", "request-1", "anna.andersson", AUDIENCE, DESTINATION);

        Map<String,Object> result = new SamlAssertionValidator().validate(new SamlAssertionRequest(
            base64(xml), idp.certificateBase64(), AUDIENCE, DESTINATION));

        assertEquals("FAIL", result.get("result"));
        assertEquals("EXACTLY_ONE_SIGNATURE_REQUIRED", result.get("reason"));
    }

    @Test
    void audienceAndDestinationAreReportedNotEnforcedHere() throws Exception {
        Idp idp = new Idp("idp.kungalv.se");
        String xml = idp.signedResponse("_assertion-5", "request-1", "anna.andersson",
            List.of("CN=Kommunsign-Handlaggare"), "https://someone-else.example/sp", DESTINATION);

        Map<String,Object> result = new SamlAssertionValidator().validate(new SamlAssertionRequest(
            base64(xml), idp.certificateBase64(), AUDIENCE, DESTINATION));

        // The signature is genuine, so this validator passes it. Refusing an
        // assertion minted for another service provider is the decision layer's
        // job, and keeping that rule in one place is why it is not repeated here.
        assertEquals("PASS", result.get("result"));
        assertEquals("https://someone-else.example/sp", result.get("audience"));
        assertFalse(checkPassed(result, "AUDIENCE_MATCHES_EXPECTED"),
            "the mismatch must still be reported so the caller cannot miss it");
    }

    @SuppressWarnings("unchecked")
    private static boolean checkPassed(Map<String,Object> result, String name) {
        for (Map<String,Object> check : (List<Map<String,Object>>) result.get("checks")) {
            if (name.equals(check.get("name"))) return Boolean.TRUE.equals(check.get("passed"));
        }
        return false;
    }

    private static String base64(String xml) {
        return Base64.getEncoder().encodeToString(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    /** An identity provider with its own key, created per test and never written to disk. */
    private static final class Idp {
        private final KeyPair keyPair;
        private final X509Certificate certificate;
        private final String host;

        Idp(String host) throws Exception {
            this.host = host;
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            this.keyPair = generator.generateKeyPair();
            X500Name name = new X500Name("CN=" + host + ",O=Kungalvs kommun,C=SE");
            Date from = new Date(System.currentTimeMillis() - 86_400_000L);
            Date to = new Date(System.currentTimeMillis() + 86_400_000L * 365);
            this.certificate = new JcaX509CertificateConverter().setProvider("BC").getCertificate(
                new JcaX509v3CertificateBuilder(name, BigInteger.valueOf(System.nanoTime()), from, to, name, keyPair.getPublic())
                    .build(new JcaContentSignerBuilder("SHA256withRSA").setProvider("BC").build(keyPair.getPrivate())));
        }

        String certificateBase64() throws Exception {
            return Base64.getEncoder().encodeToString(certificate.getEncoded());
        }

        String unsignedResponse(String assertionId, String inResponseTo, String subject, String audience, String destination) {
            return responseXml(assertionId, inResponseTo, subject, List.of("CN=Kommunsign-Handlaggare"), audience, destination);
        }

        String signedResponse(String assertionId, String inResponseTo, String subject,
                              List<String> groups, String audience, String destination) throws Exception {
            Document document = parse(responseXml(assertionId, inResponseTo, subject, groups, audience, destination));
            Element assertion = (Element) document.getElementsByTagNameNS(
                "urn:oasis:names:tc:SAML:2.0:assertion", "Assertion").item(0);
            assertion.setIdAttribute("ID", true);

            XMLSignatureFactory factory = XMLSignatureFactory.getInstance("DOM");
            Reference reference = factory.newReference("#" + assertionId,
                factory.newDigestMethod(DigestMethod.SHA256, null),
                List.of(factory.newTransform(Transform.ENVELOPED, (TransformParameterSpec) null),
                        factory.newTransform(CanonicalizationMethod.EXCLUSIVE, (TransformParameterSpec) null)),
                null, null);
            SignedInfo signedInfo = factory.newSignedInfo(
                factory.newCanonicalizationMethod(CanonicalizationMethod.EXCLUSIVE, (C14NMethodParameterSpec) null),
                factory.newSignatureMethod("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", null),
                List.of(reference));

            KeyInfoFactory keyInfoFactory = factory.getKeyInfoFactory();
            KeyInfo keyInfo = keyInfoFactory.newKeyInfo(
                List.of(keyInfoFactory.newX509Data(List.of(certificate))));

            DOMSignContext context = new DOMSignContext(keyPair.getPrivate(), assertion);
            // Placed immediately after Issuer, which is where the schema puts it.
            context.setNextSibling(assertion.getElementsByTagNameNS(
                "urn:oasis:names:tc:SAML:2.0:assertion", "Subject").item(0));
            factory.newXMLSignature(signedInfo, keyInfo).sign(context);
            return serialise(document);
        }

        private String responseXml(String assertionId, String inResponseTo, String subject,
                                   List<String> groups, String audience, String destination) {
            String now = Instant.now().toString();
            String expiry = Instant.now().plusSeconds(300).toString();
            StringBuilder attributes = new StringBuilder();
            attributes.append("<saml:Attribute Name=\"uid\"><saml:AttributeValue>")
                .append(subject).append("</saml:AttributeValue></saml:Attribute>");
            attributes.append("<saml:Attribute Name=\"memberOf\">");
            for (String group : groups) {
                attributes.append("<saml:AttributeValue>").append(group).append("</saml:AttributeValue>");
            }
            attributes.append("</saml:Attribute>");

            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                + "<samlp:Response xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\""
                + " xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\""
                + " ID=\"_response-" + assertionId + "\" Version=\"2.0\""
                + " IssueInstant=\"" + now + "\""
                + " Destination=\"" + destination + "\" InResponseTo=\"" + inResponseTo + "\">"
                + "<saml:Issuer>https://" + host + "/saml</saml:Issuer>"
                + "<samlp:Status><samlp:StatusCode Value=\"urn:oasis:names:tc:SAML:2.0:status:Success\"/></samlp:Status>"
                + "<saml:Assertion ID=\"" + assertionId + "\" Version=\"2.0\" IssueInstant=\"" + now + "\">"
                + "<saml:Issuer>https://" + host + "/saml</saml:Issuer>"
                + "<saml:Subject>"
                + "<saml:NameID Format=\"urn:oasis:names:tc:SAML:2.0:nameid-format:persistent\">" + subject + "</saml:NameID>"
                + "<saml:SubjectConfirmation Method=\"urn:oasis:names:tc:SAML:2.0:cm:bearer\">"
                + "<saml:SubjectConfirmationData NotOnOrAfter=\"" + expiry + "\""
                + " Recipient=\"" + destination + "\" InResponseTo=\"" + inResponseTo + "\"/>"
                + "</saml:SubjectConfirmation>"
                + "</saml:Subject>"
                + "<saml:Conditions NotBefore=\"" + now + "\" NotOnOrAfter=\"" + expiry + "\">"
                + "<saml:AudienceRestriction><saml:Audience>" + audience + "</saml:Audience></saml:AudienceRestriction>"
                + "</saml:Conditions>"
                + "<saml:AuthnStatement AuthnInstant=\"" + now + "\">"
                + "<saml:AuthnContext><saml:AuthnContextClassRef>"
                + "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor"
                + "</saml:AuthnContextClassRef></saml:AuthnContext>"
                + "</saml:AuthnStatement>"
                + "<saml:AttributeStatement>" + attributes + "</saml:AttributeStatement>"
                + "</saml:Assertion>"
                + "</samlp:Response>";
        }
    }

    private static Document parse(String xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        return factory.newDocumentBuilder().parse(
            new ByteArrayInputStream(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static String serialise(Document document) throws Exception {
        Transformer transformer = TransformerFactory.newInstance().newTransformer();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        transformer.transform(new DOMSource(document), new StreamResult(out));
        return out.toString(java.nio.charset.StandardCharsets.UTF_8);
    }
}
