package se.kommunsign.validation;

/**
 * A SAML Response to verify and normalise.
 *
 * `trustedCertificateBase64` is the tenant's configured IdP signing certificate.
 * It is a required input rather than something taken from the message: a
 * signature verified against a certificate the message itself carried proves
 * only that whoever wrote the message also signed it, which is what anybody
 * with a text editor can do.
 */
public record SamlAssertionRequest(
    String responseXmlBase64,
    String trustedCertificateBase64,
    String expectedAudience,
    String expectedDestination
) {}
