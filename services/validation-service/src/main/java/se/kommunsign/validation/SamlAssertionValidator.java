package se.kommunsign.validation;

import java.io.ByteArrayInputStream;
import java.security.PublicKey;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.crypto.*;
import javax.xml.crypto.dsig.*;
import javax.xml.crypto.dsig.dom.DOMValidateContext;
import javax.xml.crypto.dsig.keyinfo.*;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;

/**
 * Verifies a SAML 2.0 Response and normalises it for the decision layer.
 *
 * The split is deliberate. This class does cryptography and parsing and nothing
 * else: it decides whether the bytes were signed by the certificate the tenant
 * configured, and it reports what the message says. Whether that message may log
 * anybody in is decided by verifyWorkforceAssertion in packages/federation,
 * where every tenant rule lives in one place. A validator that also decided
 * admission would be a second, quietly diverging copy of those rules.
 *
 * Three failures are worth naming, because each is a complete authentication
 * bypass and each is easy to write by accident:
 *
 *   1. Trusting the certificate inside the message. KeyInfo is attacker-supplied.
 *      A signature that verifies against a certificate the message carried proves
 *      only that whoever wrote it also signed it. The configured certificate is
 *      therefore a required input and is compared before anything else is read.
 *   2. Reading the assertion before verifying the signature. Parsing an
 *      unverified document and then checking the signature over a different node
 *      is the XML signature wrapping attack. Here the signed element is located
 *      first and everything is read from inside it.
 *   3. Allowing external references. A Reference with an off-document URI lets
 *      the signature cover bytes nobody sees.
 */
public final class SamlAssertionValidator {
    private static final String SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
    private static final String PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
    private static final String SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
    private static final int MAX_XML_BYTES = 3_000_000;

    public Map<String,Object> validate(SamlAssertionRequest request) {
        List<Map<String,Object>> checks = new ArrayList<>();
        Map<String,Object> out = new LinkedHashMap<>();
        boolean signatureVerified = false;

        try {
            byte[] xml = decode(require(request.responseXmlBase64(), "RESPONSE_XML_REQUIRED"), MAX_XML_BYTES, "RESPONSE_XML_BASE64_INVALID");
            X509Certificate trusted = certificate(require(request.trustedCertificateBase64(), "TRUSTED_CERTIFICATE_REQUIRED"));

            Document document = secureDocument(xml);
            add(checks, "XML_SECURE_PARSE", true, null);

            Element signatureElement = oneSignature(document);
            add(checks, "XML_SINGLE_SIGNATURE", true, null);

            X509KeySelector selector = new X509KeySelector();
            DOMValidateContext context = new DOMValidateContext(selector, signatureElement);
            context.setProperty("org.jcp.xml.dsig.secureValidation", Boolean.TRUE);
            XMLSignature signature = XMLSignatureFactory.getInstance("DOM").unmarshalXMLSignature(context);

            validateReferences(signature, document);
            add(checks, "XML_REFERENCE_POLICY", true, null);

            signatureVerified = signature.validate(context);
            add(checks, "XML_DSIG_VALID", signatureVerified, null);
            if (!signatureVerified) return fail(out, checks, "SIGNATURE_INVALID");

            // Only now, and only against the configured certificate.
            boolean trustedSigner = trusted.equals(selector.certificate());
            add(checks, "SIGNER_IS_CONFIGURED_IDP", trustedSigner, null);
            if (!trustedSigner) return fail(out, checks, "SIGNER_NOT_TRUSTED");

            Element signed = signedElement(document, signature);
            Element assertion = SAML_NS.equals(signed.getNamespaceURI()) && "Assertion".equals(signed.getLocalName())
                ? signed
                : childElement(signed, SAML_NS, "Assertion");
            if (assertion == null) return fail(out, checks, "SIGNATURE_DOES_NOT_COVER_ASSERTION");
            add(checks, "SIGNATURE_COVERS_ASSERTION", true, null);

            Element response = document.getDocumentElement();
            if (PROTOCOL_NS.equals(response.getNamespaceURI()) && "Response".equals(response.getLocalName())) {
                Element status = childElement(response, PROTOCOL_NS, "Status");
                Element code = status == null ? null : childElement(status, PROTOCOL_NS, "StatusCode");
                String value = code == null ? null : code.getAttribute("Value");
                boolean success = SUCCESS.equals(value);
                add(checks, "SAML_STATUS_SUCCESS", success, null);
                if (!success) return fail(out, checks, "SAML_STATUS_NOT_SUCCESS");
                out.put("destination", emptyToNull(response.getAttribute("Destination")));
                out.put("inResponseTo", emptyToNull(response.getAttribute("InResponseTo")));
            }

            out.put("protocol", "SAML2");
            out.put("assertionId", assertion.getAttribute("ID"));
            Element issuer = childElement(assertion, SAML_NS, "Issuer");
            out.put("issuer", issuer == null ? null : issuer.getTextContent().trim());

            Element subject = childElement(assertion, SAML_NS, "Subject");
            Element nameId = subject == null ? null : childElement(subject, SAML_NS, "NameID");
            out.put("subject", nameId == null ? "" : nameId.getTextContent().trim());
            Element confirmationData = subject == null ? null
                : firstDescendant(subject, SAML_NS, "SubjectConfirmationData");
            if (confirmationData != null) {
                // The Recipient and InResponseTo on the confirmation data are the
                // authoritative ones when present: they are inside the signature,
                // where the Response-level attributes are not.
                String recipient = emptyToNull(confirmationData.getAttribute("Recipient"));
                if (recipient != null) out.put("destination", recipient);
                String inResponseTo = emptyToNull(confirmationData.getAttribute("InResponseTo"));
                if (inResponseTo != null) out.put("inResponseTo", inResponseTo);
                String notOnOrAfter = emptyToNull(confirmationData.getAttribute("NotOnOrAfter"));
                if (notOnOrAfter != null) out.put("notOnOrAfter", notOnOrAfter);
            }

            Element conditions = childElement(assertion, SAML_NS, "Conditions");
            if (conditions != null) {
                out.put("notBefore", emptyToNull(conditions.getAttribute("NotBefore")));
                String notOnOrAfter = emptyToNull(conditions.getAttribute("NotOnOrAfter"));
                if (notOnOrAfter != null) out.put("notOnOrAfter", notOnOrAfter);
                Element restriction = childElement(conditions, SAML_NS, "AudienceRestriction");
                Element audience = restriction == null ? null : childElement(restriction, SAML_NS, "Audience");
                out.put("audience", audience == null ? null : audience.getTextContent().trim());
            }

            Element statement = childElement(assertion, SAML_NS, "AuthnStatement");
            if (statement != null) {
                out.put("authenticatedAt", emptyToNull(statement.getAttribute("AuthnInstant")));
                Element authnContext = childElement(statement, SAML_NS, "AuthnContext");
                Element classRef = authnContext == null ? null : childElement(authnContext, SAML_NS, "AuthnContextClassRef");
                out.put("authnContext", classRef == null ? null : classRef.getTextContent().trim());
            }

            Map<String,List<String>> attributes = new LinkedHashMap<>();
            Element attributeStatement = childElement(assertion, SAML_NS, "AttributeStatement");
            if (attributeStatement != null) {
                NodeList nodes = attributeStatement.getElementsByTagNameNS(SAML_NS, "Attribute");
                for (int index = 0; index < nodes.getLength(); index += 1) {
                    Element attribute = (Element) nodes.item(index);
                    String name = attribute.getAttribute("Name");
                    if (name == null || name.isBlank()) continue;
                    List<String> values = new ArrayList<>();
                    NodeList valueNodes = attribute.getElementsByTagNameNS(SAML_NS, "AttributeValue");
                    for (int valueIndex = 0; valueIndex < valueNodes.getLength(); valueIndex += 1) {
                        values.add(valueNodes.item(valueIndex).getTextContent().trim());
                    }
                    attributes.put(name, values);
                }
            }
            out.put("attributes", attributes);

            // Reported, never enforced here. The decision layer compares these
            // against the tenant's configuration, so there is one place where a
            // mismatch means "refuse" rather than two that can disagree.
            add(checks, "AUDIENCE_MATCHES_EXPECTED",
                Objects.equals(out.get("audience"), request.expectedAudience()), null);
            add(checks, "DESTINATION_MATCHES_EXPECTED",
                Objects.equals(out.get("destination"), request.expectedDestination()), null);

            out.put("signatureVerified", true);
            out.put("result", "PASS");
            out.put("checks", checks);
            return out;
        } catch (RuntimeException error) {
            return fail(out, checks, safeCode(error.getMessage()));
        } catch (Exception error) {
            return fail(out, checks, "SAML_VALIDATION_FAILED");
        }
    }

    private static Map<String,Object> fail(Map<String,Object> out, List<Map<String,Object>> checks, String reason) {
        out.put("signatureVerified", false);
        out.put("result", "FAIL");
        out.put("reason", reason);
        out.put("checks", checks);
        return out;
    }

    /** The element the signature actually covers, found from its own Reference. */
    private static Element signedElement(Document document, XMLSignature signature) {
        @SuppressWarnings("unchecked")
        List<Reference> references = signature.getSignedInfo().getReferences();
        for (Reference reference : references) {
            String uri = reference.getURI();
            if (uri == null || uri.length() < 2) continue;
            Element target = document.getElementById(uri.substring(1));
            if (target != null) return target;
        }
        throw new IllegalArgumentException("SIGNED_ELEMENT_NOT_FOUND");
    }

    private static Document secureDocument(byte[] xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        // No external entities, no DTDs, no XInclude. Every one of these is a
        // way to make the parser fetch or expand something the signature never
        // covered.
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        Document document = factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
        markIdAttributes(document.getDocumentElement());
        return document;
    }

    /**
     * Registers ID attributes so Reference resolution works.
     *
     * Without a schema the parser does not know which attribute is the ID, and
     * getElementById returns null for every lookup — which would make the
     * reference check above pass vacuously by finding nothing to object to.
     */
    private static void markIdAttributes(Element element) {
        for (String name : new String[]{"ID", "Id", "id"}) {
            if (element.hasAttribute(name)) element.setIdAttribute(name, true);
        }
        NodeList children = element.getChildNodes();
        for (int index = 0; index < children.getLength(); index += 1) {
            Node child = children.item(index);
            if (child instanceof Element childElement) markIdAttributes(childElement);
        }
    }

    private static Element oneSignature(Document document) {
        NodeList nodes = document.getElementsByTagNameNS(XMLSignature.XMLNS, "Signature");
        if (nodes.getLength() != 1) throw new IllegalArgumentException("EXACTLY_ONE_SIGNATURE_REQUIRED");
        return (Element) nodes.item(0);
    }

    private static void validateReferences(XMLSignature signature, Document document) {
        @SuppressWarnings("unchecked")
        List<Reference> references = signature.getSignedInfo().getReferences();
        if (references.isEmpty() || references.size() > 4) throw new IllegalArgumentException("REFERENCE_COUNT_INVALID");
        for (Reference reference : references) {
            String uri = reference.getURI();
            if (uri == null || !uri.startsWith("#") || uri.length() < 2) {
                throw new IllegalArgumentException("EXTERNAL_REFERENCE_FORBIDDEN");
            }
            if (document.getElementById(uri.substring(1)) == null) {
                throw new IllegalArgumentException("REFERENCE_TARGET_MISSING");
            }
        }
    }

    private static Element childElement(Element parent, String namespace, String localName) {
        NodeList children = parent.getChildNodes();
        for (int index = 0; index < children.getLength(); index += 1) {
            Node child = children.item(index);
            if (child instanceof Element element
                && namespace.equals(element.getNamespaceURI())
                && localName.equals(element.getLocalName())) {
                return element;
            }
        }
        return null;
    }

    private static Element firstDescendant(Element parent, String namespace, String localName) {
        NodeList nodes = parent.getElementsByTagNameNS(namespace, localName);
        return nodes.getLength() == 0 ? null : (Element) nodes.item(0);
    }

    private static X509Certificate certificate(String base64) throws Exception {
        byte[] der = decode(base64, 50_000, "TRUSTED_CERTIFICATE_BASE64_INVALID");
        return (X509Certificate) CertificateFactory.getInstance("X.509")
            .generateCertificate(new ByteArrayInputStream(der));
    }

    private static byte[] decode(String value, int max, String code) {
        try {
            byte[] bytes = Base64.getDecoder().decode(value);
            if (bytes.length == 0 || bytes.length > max) throw new IllegalArgumentException(code);
            return bytes;
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(code);
        }
    }

    private static String require(String value, String code) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(code);
        return value;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static void add(List<Map<String,Object>> checks, String name, boolean passed, String detail) {
        Map<String,Object> check = new LinkedHashMap<>();
        check.put("name", name);
        check.put("passed", passed);
        if (detail != null) check.put("detail", detail);
        checks.add(check);
    }

    /** Never the raw exception text: it can carry fragments of the message. */
    private static String safeCode(String message) {
        if (message == null) return "SAML_VALIDATION_FAILED";
        String upper = message.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9_]", "_");
        return upper.length() > 80 ? upper.substring(0, 80) : upper;
    }

    private static final class X509KeySelector extends KeySelector {
        private X509Certificate certificate;
        X509Certificate certificate() { return certificate; }
        @Override public KeySelectorResult select(KeyInfo keyInfo, Purpose purpose, AlgorithmMethod method, XMLCryptoContext context) throws KeySelectorException {
            if (keyInfo == null) throw new KeySelectorException("KEYINFO_MISSING");
            for (Object content : keyInfo.getContent()) {
                if (content instanceof X509Data data) {
                    for (Object item : data.getContent()) {
                        if (item instanceof X509Certificate cert) {
                            this.certificate = cert;
                            PublicKey key = cert.getPublicKey();
                            return () -> key;
                        }
                    }
                }
            }
            throw new KeySelectorException("X509_CERTIFICATE_MISSING");
        }
    }
}
