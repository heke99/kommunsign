package se.kommunsign.validation;

/**
 * An OIDC id_token to verify and normalise.
 *
 * `trustedCertificateBase64` carries the tenant's configured IdP signing
 * certificate, exactly as the SAML path does. Fetching a JWKS from a URL in the
 * token would be taking the key from the message, which proves nothing.
 */
public record OidcTokenRequest(
    String idToken,
    String trustedCertificateBase64,
    String expectedIssuer,
    String expectedAudience,
    String expectedNonce
) {}
