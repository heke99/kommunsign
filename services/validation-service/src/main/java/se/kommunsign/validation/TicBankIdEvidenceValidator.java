package se.kommunsign.validation;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.*;
import java.util.regex.*;
import javax.xml.XMLConstants;
import javax.xml.crypto.*;
import javax.xml.crypto.dsig.*;
import javax.xml.crypto.dsig.dom.DOMValidateContext;
import javax.xml.crypto.dsig.keyinfo.*;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.security.auth.x500.X500Principal;
import org.w3c.dom.*;

public final class TicBankIdEvidenceValidator {
    private static final int MAX_XML_BYTES = 3_000_000;
    private static final Pattern PERSONAL_NUMBER = Pattern.compile("(?<!\\d)(\\d{12})(?!\\d)");

    public Map<String,Object> validate(TicBankIdValidationRequest request) {
        List<Map<String,Object>> checks = new ArrayList<>();
        String result = "FAIL", personalNumber = null, displayName = null;
        byte[] xml = decode(request.signatureXmlBase64(), MAX_XML_BYTES, "SIGNATURE_XML_BASE64_INVALID");
        byte[] ocsp = decode(request.ocspResponseBase64(), 750_000, "OCSP_BASE64_INVALID");
        try {
            Document document = secureDocument(xml); add(checks,"XML_SECURE_PARSE",true,null);
            Element signatureElement = oneSignature(document); add(checks,"XML_SINGLE_SIGNATURE",true,null);
            registerUniqueIds(document); add(checks,"XML_ID_UNIQUENESS",true,null);
            X509KeySelector selector = new X509KeySelector();
            DOMValidateContext context = new DOMValidateContext(selector, signatureElement);
            context.setProperty("org.jcp.xml.dsig.secureValidation", Boolean.TRUE);
            XMLSignature signature = XMLSignatureFactory.getInstance("DOM").unmarshalXMLSignature(context);
            validateReferences(signature, document); add(checks,"XML_REFERENCE_POLICY",true,null);
            boolean signatureValid = signature.validate(context); add(checks,"XML_DSIG_VALID",signatureValid,null);
            if (!signatureValid) throw new GeneralSecurityException("XML signature invalid");
            X509Certificate certificate = selector.certificate();
            if (certificate == null) throw new GeneralSecurityException("X509 certificate missing");
            certificate.checkValidity(); add(checks,"SIGNER_CERTIFICATE_TIME_VALID",true,null);
            String allText = document.getDocumentElement().getTextContent();
            boolean visibleMatch = containsExactOrBase64(allText, request.expectedVisibleData());
            boolean nonVisibleMatch = containsExactOrBase64(allText, request.expectedNonVisibleData());
            add(checks,"VISIBLE_DATA_MATCH",visibleMatch,null); add(checks,"NON_VISIBLE_DATA_MATCH",nonVisibleMatch,null);
            if (!visibleMatch || !nonVisibleMatch) throw new GeneralSecurityException("signed data mismatch");
            personalNumber = extractPersonalNumber(certificate, document);
            add(checks,"IDENTITY_PRESENT",personalNumber != null,null);
            if (personalNumber == null) throw new GeneralSecurityException("identity missing");
            boolean expectedMatch = request.expectedPersonalNumber()==null || request.expectedPersonalNumber().equals(personalNumber);
            add(checks,"PERSONAL_NUMBER_MATCH",expectedMatch,request.expectedPersonalNumber()==null?"BANKID_DISCOVERED":null);
            if (!expectedMatch) throw new GeneralSecurityException("personal number mismatch");
            displayName = certificate.getSubjectX500Principal().getName(X500Principal.RFC2253);
            boolean ocspParsable = isDerSequence(ocsp); add(checks,"OCSP_PRESENT_AND_DER",ocspParsable,null);
            if (!ocspParsable) throw new GeneralSecurityException("OCSP invalid");
            result = "PASS";
        } catch (Exception exception) {
            add(checks,"VALIDATION_TERMINAL",false,safe(exception));
        }
        Map<String,Object> response = new LinkedHashMap<>(); response.put("result",result); response.put("checks",checks);
        if(personalNumber!=null)response.put("personalNumber",personalNumber); if(displayName!=null)response.put("displayName",displayName);
        response.put("visibleDataSha256",sha256(request.expectedVisibleData().getBytes(StandardCharsets.UTF_8)));
        response.put("nonVisibleDataSha256",sha256(request.expectedNonVisibleData().getBytes(StandardCharsets.UTF_8)));
        response.put("signatureXmlSha256",sha256(xml)); response.put("ocspSha256",sha256(ocsp));
        response.put("engine","jdk-xml-dsig/secure-validation-v1"); response.put("policyVersion",request.policyVersion()); response.put("verifiedAt",Instant.now().toString());
        return response;
    }

    private static Document secureDocument(byte[] xml) throws Exception {
        DocumentBuilderFactory factory=DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true); factory.setXIncludeAware(false); factory.setExpandEntityReferences(false);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true); factory.setFeature("http://xml.org/sax/features/external-general-entities",false); factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false); factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD,""); factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }
    private static Element oneSignature(Document document) { NodeList nodes=document.getElementsByTagNameNS(XMLSignature.XMLNS,"Signature"); if(nodes.getLength()!=1)throw new IllegalArgumentException("exactly one Signature required"); return (Element)nodes.item(0); }
    private static void registerUniqueIds(Document document) { Map<String,Element> ids=new HashMap<>(); NodeList all=document.getElementsByTagName("*"); for(int i=0;i<all.getLength();i++){Element element=(Element)all.item(i); for(String name:List.of("Id","ID","id")){if(element.hasAttribute(name)){String value=element.getAttribute(name);if(value.isBlank()||ids.put(value,element)!=null)throw new IllegalArgumentException("duplicate XML ID"); element.setIdAttribute(name,true);}}} }
    private static void validateReferences(XMLSignature signature, Document document) { @SuppressWarnings("unchecked") List<Reference> refs=signature.getSignedInfo().getReferences(); if(refs.isEmpty()||refs.size()>10)throw new IllegalArgumentException("reference count invalid"); for(Reference ref:refs){String uri=ref.getURI(); if(uri==null||!uri.startsWith("#")||uri.length()<2)throw new IllegalArgumentException("external or empty reference forbidden"); Element target=document.getElementById(uri.substring(1)); if(target==null)throw new IllegalArgumentException("reference target missing");} }
    private static boolean containsExactOrBase64(String allText,String expected){if(allText.contains(expected))return true;String encoded=Base64.getEncoder().encodeToString(expected.getBytes(StandardCharsets.UTF_8));return allText.replaceAll("\\s","").contains(encoded);}
    private static String extractPersonalNumber(X509Certificate certificate,Document document){String subject=certificate.getSubjectX500Principal().getName(X500Principal.RFC2253);Matcher m=PERSONAL_NUMBER.matcher(subject);if(m.find())return m.group(1);m=PERSONAL_NUMBER.matcher(document.getDocumentElement().getTextContent());return m.find()?m.group(1):null;}
    private static boolean isDerSequence(byte[] bytes){if(bytes.length<2||(bytes[0]&0xff)!=0x30)return false;int first=bytes[1]&0xff;if(first<128)return first==bytes.length-2;int count=first&0x7f;if(count<1||count>4||2+count>bytes.length)return false;int length=0;for(int i=0;i<count;i++)length=(length<<8)|(bytes[2+i]&0xff);return length==bytes.length-2-count;}
    private static byte[] decode(String value,int max,String code){try{byte[] bytes=Base64.getDecoder().decode(value);if(bytes.length==0||bytes.length>max)throw new IllegalArgumentException(code);return bytes;}catch(IllegalArgumentException e){throw new IllegalArgumentException(code);}}
    private static String sha256(byte[] bytes){try{byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);return HexFormat.of().formatHex(digest);}catch(Exception e){throw new IllegalStateException(e);}}
    private static void add(List<Map<String,Object>> checks,String code,boolean passed,String detail){Map<String,Object> item=new LinkedHashMap<>();item.put("code",code);item.put("passed",passed);if(detail!=null)item.put("detail",detail);checks.add(item);}
    private static String safe(Exception exception){String name=exception.getClass().getSimpleName().replaceAll("[^A-Za-z0-9_]","");return name.isBlank()?"VALIDATION_FAILED":name;}
    private static final class X509KeySelector extends KeySelector { private X509Certificate certificate; X509Certificate certificate(){return certificate;} @Override public KeySelectorResult select(KeyInfo keyInfo,Purpose purpose,AlgorithmMethod method,XMLCryptoContext context)throws KeySelectorException{if(keyInfo==null)throw new KeySelectorException("KeyInfo missing");for(Object content:keyInfo.getContent()){XMLStructure structure=(XMLStructure)content;if(structure instanceof X509Data data){for(Object item:data.getContent()){if(item instanceof X509Certificate cert){this.certificate=cert;PublicKey key=cert.getPublicKey();return ()->key;}}}}throw new KeySelectorException("X509 certificate missing");} }
}
